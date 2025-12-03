import fs from "fs";
import path from "path";
import { getProjectQueueStatus } from "./versioning";

const LOCK_DIR = path.resolve(__dirname, ".");
const LOCK_TIMEOUT_MS = 1000 * 60 * 1; // 1分钟
const LOCK_HEARTBEAT_INTERVAL_MS = 15 * 1000; // 心跳 15s

/**
 * 获取项目特定的锁文件路径
 * @param projectId 项目ID
 * @returns 锁文件路径
 */
function getLockFilePath(projectId: string): string {
  return path.resolve(LOCK_DIR, `.sync_lock_${projectId}`);
}

// 项目锁信息接口
interface ProjectLockInfo {
  projectId: string;
  taskId?: string;
  timestamp: number;
  status: "processing" | "queued";
}

/**
 * 拍平json
 * @param obj 需要拍平的json对象
 * @param prefix 前缀
 * @param result 结果
 * @returns 拍平后的json对象
 */
function flatten(obj: any, prefix = "", result: Record<string, any> = {}) {
  for (const key in obj) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flatten(value, newKey, result);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          flatten(item, `${newKey}.${index}`, result);
        } else {
          result[`${newKey}.${index}`] = item;
        }
      });
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

/**
 * 展开json
 * @param flatObj
 * @returns
 */
function unflattenJSON(flatObj: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const key in flatObj) {
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const isArrayIndex = /^\d+$/.test(nextPart);

      if (i === parts.length - 1) {
        current[part] = flatObj[key];
      } else {
        if (!(part in current)) {
          current[part] = isArrayIndex ? [] : {};
        }
        current = current[part];
      }
    }
  }
  return result;
}

/**
 * 辅助函数：将数组分成多个小块
 * @param array 需要分块的数组
 * @param chunkSize 每个小块的大小
 * @returns 分块后的数组
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
}

// 稳定 stringify：保证 key 顺序一致
function stableStringify(obj: Record<string, any>): string {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {} as Record<string, any>);
  return JSON.stringify(sorted);
}

/**
 * 判断两个 JSON 文件或对象是否有变化
 */
function isJsonChanged(
  jsonA: Record<string, any>,
  jsonB: Record<string, any>
): boolean {
  const objA = jsonA;
  const objB = jsonB;

  const flatA = flatten(objA);
  const flatB = flatten(objB);

  return stableStringify(flatA) !== stableStringify(flatB);
}

/**
 * 尝试获取文件锁，并支持超时机制
 * @param projectId 项目ID，用于记录锁信息
 * @param taskId 任务ID，可选
 * @returns {Promise<boolean>} 如果成功获取锁返回 true，否则返回 false
 */
async function acquireLock(
  projectId?: string,
  taskId?: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const lockFile = getLockFilePath(projectId || "unknown");
    // 尝试以独占写入模式创建文件
    fs.open(lockFile, "wx", async (err, fd) => {
      if (err) {
        if (err.code === "EEXIST") {
          // 锁文件已存在，检查是否超时
          try {
            const lockContent = fs.readFileSync(lockFile, "utf-8");
            let lockInfo: ProjectLockInfo;

            try {
              // 尝试解析为JSON格式（新格式）
              lockInfo = JSON.parse(lockContent);
            } catch {
              // 兼容旧格式（纯时间戳）
              const lockTimestamp = parseInt(lockContent, 10);
              if (isNaN(lockTimestamp)) {
                console.warn(
                  `⚠️ 锁文件内容无效，尝试强制删除并重新获取锁: ${lockFile}`
                );
                releaseLock(projectId); // 内容无效，尝试释放旧锁
                return resolve(await acquireLock(projectId, taskId)); // 递归重试
              }

              // 转换为新格式
              lockInfo = {
                projectId: "legacy",
                timestamp: lockTimestamp,
                status: "processing",
              };
            }

            const currentTime = Date.now();
            if (currentTime - lockInfo.timestamp > LOCK_TIMEOUT_MS) {
              console.warn(
                `⚠️ 锁文件已超时 (${
                  (currentTime - lockInfo.timestamp) / 1000
                }s)，强制删除并重新获取锁: ${lockFile}`
              );
              releaseLock(projectId); // 锁超时，强制释放
              return resolve(await acquireLock(projectId, taskId)); // 递归重试获取锁
            } else {
              // 锁未超时，获取锁失败
              return resolve(false);
            }
          } catch (readErr: any) {
            console.error(`读取或处理锁文件时发生错误: ${readErr.message}`);
            return reject(readErr); // 读取错误，直接拒绝
          }
        }
        // 其他错误，直接拒绝
        console.error(`获取文件锁时发生未知错误: ${err.message}`);
        return reject(err);
      }

      // 成功创建文件，写入锁信息
      const lockInfo: ProjectLockInfo = {
        projectId: projectId || "unknown",
        taskId,
        timestamp: Date.now(),
        status: "processing",
      };
      const lockContent = JSON.stringify(lockInfo);
      fs.write(fd, lockContent, (writeErr) => {
        fs.close(fd, (closeErr) => {
          if (closeErr) console.error("关闭锁文件描述符时发生错误:", closeErr);
        });
        if (writeErr) {
          console.error(`写入锁文件时间戳时发生错误: ${writeErr.message}`);
          releaseLock(projectId); // 写入失败，释放锁
          return reject(writeErr);
        }
        resolve(true); // 成功获取锁
      });
    });
  });
}

/**
 * 释放文件锁
 * @param projectId 项目ID
 */
function releaseLock(projectId?: string): void {
  try {
    const lockFile = getLockFilePath(projectId || "unknown");
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile); // 删除锁文件
      console.log(`[${projectId}] 文件锁已释放。`);
    }
  } catch (err) {
    console.error(`[${projectId}] 释放文件锁时发生错误:`, err);
  }
}

/**
 * 判断当前锁是否处于有效期内（用于跨请求/多实例状态探测）。
 * @param projectId 项目ID，如果提供则只检查该项目的锁状态
 */
function isLockActive(projectId?: string): boolean {
  try {
    const lockFile = getLockFilePath(projectId || "unknown");
    if (!fs.existsSync(lockFile)) return false;
    const content = fs.readFileSync(lockFile, "utf-8");

    let lockInfo: ProjectLockInfo;
    try {
      // 尝试解析为JSON格式（新格式）
      lockInfo = JSON.parse(content);
    } catch {
      // 兼容旧格式（纯时间戳）
      const ts = parseInt(content, 10);
      if (isNaN(ts)) return false;

      // 如果指定了项目ID，但锁是旧格式，返回false（旧格式无法区分项目）
      if (projectId) return false;

      return Date.now() - ts <= LOCK_TIMEOUT_MS;
    }

    // 检查时间是否超时
    if (Date.now() - lockInfo.timestamp > LOCK_TIMEOUT_MS) {
      return false;
    }

    // 如果指定了项目ID，检查是否匹配
    if (projectId) {
      return lockInfo.projectId === projectId;
    }

    // 未指定项目ID，返回全局锁状态
    return true;
  } catch {
    return false;
  }
}

/**
 * 刷新锁文件时间戳（用于心跳续租）。
 * @param projectId 项目ID
 */
function refreshLockTimestamp(projectId?: string): void {
  try {
    const lockFile = getLockFilePath(projectId || "unknown");
    if (!fs.existsSync(lockFile)) return;

    const content = fs.readFileSync(lockFile, "utf-8");
    let lockInfo: ProjectLockInfo;

    try {
      // 尝试解析为JSON格式（新格式）
      lockInfo = JSON.parse(content);
    } catch {
      // 兼容旧格式（纯时间戳）
      const ts = parseInt(content, 10);
      if (isNaN(ts)) return;

      // 转换为新格式
      lockInfo = {
        projectId: "legacy",
        timestamp: ts,
        status: "processing",
      };
    }

    // 更新时间戳
    lockInfo.timestamp = Date.now();
    const updatedContent = JSON.stringify(lockInfo);
    fs.writeFileSync(lockFile, updatedContent, { encoding: "utf-8" });
  } catch (err) {
    console.error("刷新锁文件时间戳失败:", (err as any)?.message || err);
  }
}

/**
 * 启动锁心跳，返回一个停止函数，调用后停止心跳。
 * @param projectId 项目ID
 */
function startLockHeartbeat(projectId?: string): () => void {
  const timer = setInterval(() => {
    refreshLockTimestamp(projectId);
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  // 避免阻止进程退出
  if ((timer as any).unref) {
    (timer as any).unref();
  }
  return () => clearInterval(timer);
}

/**
 * 获取项目级别的翻译状态
 * @param projectId 项目ID
 * @returns 项目翻译状态信息
 */
async function getProjectSyncStatus(projectId: string): Promise<{
  isAsyncing: boolean;
  status: "idle" | "processing" | "queued";
  taskId?: string;
  timestamp?: number;
}> {
  try {
    // 首先检查锁状态
    const lockActive = isLockActive(projectId);

    if (lockActive) {
      // 项目正在处理中
      const lockFile = getLockFilePath(projectId);
      if (!fs.existsSync(lockFile)) {
        return { isAsyncing: false, status: "idle" };
      }

      const content = fs.readFileSync(lockFile, "utf-8");
      let lockInfo: ProjectLockInfo;

      try {
        lockInfo = JSON.parse(content);
      } catch {
        return { isAsyncing: false, status: "idle" };
      }

      return {
        isAsyncing: true,
        status: "processing",
        taskId: lockInfo.taskId,
        timestamp: lockInfo.timestamp,
      };
    }

    // 锁不活跃，检查队列状态
    const queueStatus = await getProjectQueueStatus(projectId);

    if (queueStatus.isInQueue) {
      return {
        isAsyncing: false,
        status: queueStatus.status === "processing" ? "processing" : "queued",
        taskId: queueStatus.taskId,
        timestamp: queueStatus.timestamp,
      };
    }

    return { isAsyncing: false, status: "idle" };
  } catch {
    return { isAsyncing: false, status: "idle" };
  }
}

export {
  flatten,
  unflattenJSON,
  isJsonChanged,
  acquireLock,
  releaseLock,
  chunkArray,
  isLockActive,
  startLockHeartbeat,
  refreshLockTimestamp,
  getProjectSyncStatus,
};
