import fs from "fs";
import path from "path";

const CID_MAPPING_FILE = path.resolve(__dirname, "../cache/cid_mapping.json");

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
  const MOCK_MAPPING = JSON.parse(fs.readFileSync(CID_MAPPING_FILE, "utf8"));
  if (MOCK_MAPPING[commitId]) return MOCK_MAPPING[commitId];

  return null;
}
