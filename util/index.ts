import fs from "fs";
import path from "path";

const LOCK_FILE = path.resolve(__dirname, "./sync_lock");
const LOCK_TIMEOUT_MS = 1000 * 60 * 1; // 1分钟

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
 * @returns {Promise<boolean>} 如果成功获取锁返回 true，否则返回 false
 */
async function acquireLock(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // 尝试以独占写入模式创建文件
    fs.open(LOCK_FILE, "wx", async (err, fd) => {
      if (err) {
        if (err.code === "EEXIST") {
          // 锁文件已存在，检查是否超时
          try {
            const lockContent = fs.readFileSync(LOCK_FILE, "utf-8");
            const lockTimestamp = parseInt(lockContent, 10); // 解析时间戳

            if (isNaN(lockTimestamp)) {
              console.warn(
                `⚠️ 锁文件内容无效，尝试强制删除并重新获取锁: ${LOCK_FILE}`
              );
              releaseLock(); // 内容无效，尝试释放旧锁
              return resolve(await acquireLock()); // 递归重试
            }

            const currentTime = Date.now();
            if (currentTime - lockTimestamp > LOCK_TIMEOUT_MS) {
              console.warn(
                `⚠️ 锁文件已超时 (${
                  (currentTime - lockTimestamp) / 1000
                }s)，强制删除并重新获取锁: ${LOCK_FILE}`
              );
              releaseLock(); // 锁超时，强制释放
              return resolve(await acquireLock()); // 递归重试获取锁
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

      // 成功创建文件，写入当前时间戳作为锁的创建时间
      const timestamp = Date.now().toString();
      fs.write(fd, timestamp, (writeErr) => {
        fs.close(fd, (closeErr) => {
          if (closeErr) console.error("关闭锁文件描述符时发生错误:", closeErr);
        });
        if (writeErr) {
          console.error(`写入锁文件时间戳时发生错误: ${writeErr.message}`);
          releaseLock(); // 写入失败，释放锁
          return reject(writeErr);
        }
        resolve(true); // 成功获取锁
      });
    });
  });
}

/**
 * 释放文件锁
 */
function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE); // 删除锁文件
      console.log("文件锁已释放。");
    }
  } catch (err) {
    console.error("释放文件锁时发生错误:", err);
  }
}

export {
  flatten,
  unflattenJSON,
  isJsonChanged,
  acquireLock,
  releaseLock,
  chunkArray,
};
