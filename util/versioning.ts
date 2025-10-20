import fs from "fs";
import path from "path";

// 获取项目根目录，兼容开发环境和生产环境
function getProjectRoot(): string {
  // 在开发环境中，__dirname 是 util/
  // 在生产环境中，__dirname 是 dist/util/
  const isProduction = __dirname.includes('dist');
  return isProduction ? path.resolve(__dirname, '../../') : path.resolve(__dirname, '../');
}

const PROJECT_ROOT = getProjectRoot();
const CID_MAPPING_FILE = path.resolve(PROJECT_ROOT, "cache/cid_mapping.json");
const PROMOTE_REQUESTS_FILE = path.resolve(PROJECT_ROOT, "cache/promote_requests.json");
const TRANSLATION_QUEUE_FILE = path.resolve(PROJECT_ROOT, "cache/translation_queue.json");

/**
 * 生成当前时间戳作为版本号，格式为 YYYYMMDDHHmmss（本地时间）。
 * 例如：20250702144736
 */
export function generateTimestampVersion(): string {
  const now = new Date();
  const isProduction = process.env.NODE_ENV === "production";
  const pad = (num: number) => (num < 10 ? "0" + num : "" + num);

  // 生产环境使用 UTC 时间
  if (isProduction) {
    return (
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
        now.getUTCDate()
      )}` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(
        now.getUTCSeconds()
      )}`
    );
  }

  // 开发环境使用本地时间
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * 建立 Commit ID 与 Lang Version 的映射
 * @param commitId Commit ID
 * @param version Lang Version
 */
export async function createCommitIdVersionMapping(
  commitId: string,
  version: string
): Promise<void> {
  console.log(
    `[VERSIONING] Commit ID: ${commitId} mapped to Version: ${version}`
  );

  let MOCK_MAPPING: Record<string, string> = {};

  try {
    if (fs.existsSync(CID_MAPPING_FILE)) {
      const content = fs.readFileSync(CID_MAPPING_FILE, "utf8").trim();
      if (content) {
        MOCK_MAPPING = JSON.parse(content);
      }
    } else {
      // 若文件不存在，则初始化一个空对象
      fs.mkdirSync(path.dirname(CID_MAPPING_FILE), { recursive: true });
    }
  } catch (err) {
    console.warn(
      "[VERSIONING] Failed to parse cid_mapping.json, reinitializing...",
      err
    );
    MOCK_MAPPING = {};
  }

  // 更新映射并保存
  MOCK_MAPPING[commitId] = version;
  fs.writeFileSync(CID_MAPPING_FILE, JSON.stringify(MOCK_MAPPING, null, 2));
}

/**
 * 根据 Commit ID 查找对应的语言版本号
 * @param commitId Commit ID
 * @returns Lang Version
 */
export async function getLangVersionByCommitId(
  commitId: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(CID_MAPPING_FILE)) {
      console.warn(`[VERSIONING] 映射文件不存在: ${CID_MAPPING_FILE}`);
      return null;
    }

    const content = fs.readFileSync(CID_MAPPING_FILE, "utf8").trim();
    if (!content) {
      console.warn(`[VERSIONING] 映射文件为空: ${CID_MAPPING_FILE}`);
      return null;
    }

    const MOCK_MAPPING = JSON.parse(content);
    if (MOCK_MAPPING[commitId]) return MOCK_MAPPING[commitId];

    return null;
  } catch (err) {
    console.warn(`[VERSIONING] 读取映射文件失败: ${CID_MAPPING_FILE}`, err);
    return null;
  }
}

/**
 * 记录推广请求到缓存
 * @param commitId Commit ID
 * @param projectId 项目 ID
 */
export async function recordPromoteRequest(
  commitId: string,
  projectId: string
): Promise<void> {
  console.log(
    `[VERSIONING] 记录推广请求: Commit ID ${commitId}, Project ID ${projectId}`
  );

  let PROMOTE_REQUESTS: Record<
    string,
    { projectId: string; timestamp: number }
  > = {};

  try {
    if (fs.existsSync(PROMOTE_REQUESTS_FILE)) {
      const content = fs.readFileSync(PROMOTE_REQUESTS_FILE, "utf8").trim();
      if (content) {
        PROMOTE_REQUESTS = JSON.parse(content);
      }
    } else {
      // 若文件不存在，则初始化一个空对象
      fs.mkdirSync(path.dirname(PROMOTE_REQUESTS_FILE), { recursive: true });
    }
  } catch (err) {
    console.warn(
      "[VERSIONING] Failed to parse promote_requests.json, reinitializing...",
      err
    );
    PROMOTE_REQUESTS = {};
  }

  // 检查是否已存在相同的推广请求，如果存在则更新
  if (PROMOTE_REQUESTS[commitId]) {
    console.log(`[VERSIONING] 更新已存在的推广请求: ${commitId}`);
  }

  // 记录推广请求
  PROMOTE_REQUESTS[commitId] = {
    projectId,
    timestamp: Date.now(),
  };
  fs.writeFileSync(
    PROMOTE_REQUESTS_FILE,
    JSON.stringify(PROMOTE_REQUESTS, null, 2)
  );
}

/**
 * 获取所有待推广的请求（自动清理超时请求）
 * @param projectId 项目 ID，用于过滤请求
 * @returns 待推广请求列表
 */
export async function getPendingPromoteRequests(
  projectId?: string
): Promise<Array<{ commitId: string; projectId: string; timestamp: number }>> {
  try {
    if (!fs.existsSync(PROMOTE_REQUESTS_FILE)) {
      return [];
    }

    const content = fs.readFileSync(PROMOTE_REQUESTS_FILE, "utf8").trim();
    if (!content) {
      return [];
    }

    const PROMOTE_REQUESTS = JSON.parse(content);
    const now = Date.now();
    const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24小时超时
    const validRequests: Array<{
      commitId: string;
      projectId: string;
      timestamp: number;
    }> = [];
    const updatedRequests: Record<
      string,
      { projectId: string; timestamp: number }
    > = {};

    // 过滤有效请求并清理超时请求
    for (const [commitId, data] of Object.entries(PROMOTE_REQUESTS) as [
      string,
      any
    ][]) {
      const isTimeout = now - data.timestamp > TIMEOUT_MS;
      const isProjectMatch = !projectId || data.projectId === projectId;

      if (isTimeout) {
        console.log(`[VERSIONING] 清理超时的推广请求: ${commitId}`);
      } else if (isProjectMatch) {
        validRequests.push({
          commitId,
          projectId: data.projectId,
          timestamp: data.timestamp,
        });
        updatedRequests[commitId] = data;
      } else {
        // 保留其他项目的请求
        updatedRequests[commitId] = data;
      }
    }

    // 如果有清理的请求，更新文件
    if (
      Object.keys(updatedRequests).length !==
      Object.keys(PROMOTE_REQUESTS).length
    ) {
      fs.writeFileSync(
        PROMOTE_REQUESTS_FILE,
        JSON.stringify(updatedRequests, null, 2)
      );
    }

    return validRequests;
  } catch (err) {
    console.warn("[VERSIONING] Failed to read promote_requests.json", err);
    return [];
  }
}

/**
 * 移除已处理的推广请求
 * @param commitId Commit ID
 */
export async function removePromoteRequest(commitId: string): Promise<void> {
  try {
    if (!fs.existsSync(PROMOTE_REQUESTS_FILE)) {
      return;
    }

    const content = fs.readFileSync(PROMOTE_REQUESTS_FILE, "utf8").trim();
    if (!content) {
      return;
    }

    const PROMOTE_REQUESTS = JSON.parse(content);
    delete PROMOTE_REQUESTS[commitId];
    fs.writeFileSync(
      PROMOTE_REQUESTS_FILE,
      JSON.stringify(PROMOTE_REQUESTS, null, 2)
    );

    console.log(`[VERSIONING] 已移除推广请求: ${commitId}`);
  } catch (err) {
    console.warn("[VERSIONING] Failed to remove promote request", err);
  }
}

// 翻译任务队列相关类型定义
export interface TranslationTask {
  id: string;
  projectId: string;
  uploadedEnJsonContent: string | null;
  promoteToCurrent: boolean;
  commitId: string | null;
  timestamp: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

/**
 * 添加翻译任务到队列
 * @param task 翻译任务
 */
export async function addTranslationTask(task: Omit<TranslationTask, 'id' | 'timestamp' | 'status'>): Promise<string> {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const fullTask: TranslationTask = {
    ...task,
    id: taskId,
    timestamp: Date.now(),
    status: 'pending',
  };

  console.log(`[VERSIONING] 添加翻译任务到队列: ${taskId} (项目: ${task.projectId})`);

  let queue: TranslationTask[] = [];

  try {
    if (fs.existsSync(TRANSLATION_QUEUE_FILE)) {
      const content = fs.readFileSync(TRANSLATION_QUEUE_FILE, "utf8").trim();
      if (content) {
        queue = JSON.parse(content);
      }
    } else {
      // 若文件不存在，则初始化
      fs.mkdirSync(path.dirname(TRANSLATION_QUEUE_FILE), { recursive: true });
    }
  } catch (err) {
    console.warn("[VERSIONING] Failed to parse translation_queue.json, reinitializing...", err);
    queue = [];
  }

  // 检查是否已存在相同的任务（避免重复）
  const existingTask = queue.find(t => 
    t.projectId === task.projectId && 
    t.commitId === task.commitId && 
    t.status === 'pending'
  );

  if (existingTask) {
    console.log(`[VERSIONING] 项目 ${task.projectId} 已有待处理的翻译任务，跳过重复添加`);
    return existingTask.id;
  }

  queue.push(fullTask);
  fs.writeFileSync(TRANSLATION_QUEUE_FILE, JSON.stringify(queue, null, 2));
  
  return taskId;
}

/**
 * 获取下一个待处理的翻译任务
 * @returns 下一个翻译任务或 null
 */
export async function getNextTranslationTask(): Promise<TranslationTask | null> {
  try {
    if (!fs.existsSync(TRANSLATION_QUEUE_FILE)) {
      return null;
    }

    const content = fs.readFileSync(TRANSLATION_QUEUE_FILE, "utf8").trim();
    if (!content) {
      return null;
    }

    const queue: TranslationTask[] = JSON.parse(content);
    
    // 查找第一个待处理的任务
    const nextTask = queue.find(task => task.status === 'pending');
    
    if (nextTask) {
      // 标记为处理中
      nextTask.status = 'processing';
      fs.writeFileSync(TRANSLATION_QUEUE_FILE, JSON.stringify(queue, null, 2));
      console.log(`[VERSIONING] 获取下一个翻译任务: ${nextTask.id} (项目: ${nextTask.projectId})`);
    }

    return nextTask || null;
  } catch (err) {
    console.warn("[VERSIONING] Failed to read translation_queue.json", err);
    return null;
  }
}

/**
 * 更新翻译任务状态
 * @param taskId 任务 ID
 * @param status 新状态
 */
export async function updateTranslationTaskStatus(taskId: string, status: TranslationTask['status']): Promise<void> {
  try {
    if (!fs.existsSync(TRANSLATION_QUEUE_FILE)) {
      return;
    }

    const content = fs.readFileSync(TRANSLATION_QUEUE_FILE, "utf8").trim();
    if (!content) {
      return;
    }

    const queue: TranslationTask[] = JSON.parse(content);
    const taskIndex = queue.findIndex(task => task.id === taskId);
    
    if (taskIndex !== -1) {
      queue[taskIndex].status = status;
      fs.writeFileSync(TRANSLATION_QUEUE_FILE, JSON.stringify(queue, null, 2));
      console.log(`[VERSIONING] 更新翻译任务状态: ${taskId} -> ${status}`);
    }
  } catch (err) {
    console.warn("[VERSIONING] Failed to update translation task status", err);
  }
}

/**
 * 移除已完成的翻译任务
 * @param taskId 任务 ID
 */
export async function removeTranslationTask(taskId: string): Promise<void> {
  try {
    if (!fs.existsSync(TRANSLATION_QUEUE_FILE)) {
      return;
    }

    const content = fs.readFileSync(TRANSLATION_QUEUE_FILE, "utf8").trim();
    if (!content) {
      return;
    }

    const queue: TranslationTask[] = JSON.parse(content);
    const filteredQueue = queue.filter(task => task.id !== taskId);
    
    if (filteredQueue.length !== queue.length) {
      fs.writeFileSync(TRANSLATION_QUEUE_FILE, JSON.stringify(filteredQueue, null, 2));
      console.log(`[VERSIONING] 移除翻译任务: ${taskId}`);
    }
  } catch (err) {
    console.warn("[VERSIONING] Failed to remove translation task", err);
  }
}

/**
 * 获取队列中待处理任务数量
 * @param projectId 项目 ID，可选
 * @returns 待处理任务数量
 */
export async function getPendingTaskCount(projectId?: string): Promise<number> {
  try {
    if (!fs.existsSync(TRANSLATION_QUEUE_FILE)) {
      return 0;
    }

    const content = fs.readFileSync(TRANSLATION_QUEUE_FILE, "utf8").trim();
    if (!content) {
      return 0;
    }

    const queue: TranslationTask[] = JSON.parse(content);
    
    if (projectId) {
      return queue.filter(task => task.projectId === projectId && task.status === 'pending').length;
    } else {
      return queue.filter(task => task.status === 'pending').length;
    }
  } catch (err) {
    console.warn("[VERSIONING] Failed to get pending task count", err);
    return 0;
  }
}
