import fs from "fs";
import path from "path";

const CID_MAPPING_FILE = path.resolve(__dirname, "../cache/cid_mapping.json");
const PROMOTE_REQUESTS_FILE = path.resolve(
  __dirname,
  "../cache/promote_requests.json"
);

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
