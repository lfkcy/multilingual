import OSS from "ali-oss";

/**
 * OSS 配置接口
 */
interface OssConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint?: string; // 可选，如果不是经典域名，需要配置
  secure?: boolean; // 可选，是否使用 HTTPS，默认为 true
}

/**
 * 文件信息接口
 */
interface FileInfo {
  name: string; // 文件名 (da.json)
  size: number; // 文件大小 (字节)
  lastModified: string; // 最后修改时间
  etag: string; // ETag
}

/**
 * OSS 工具类
 */
export class OssUtil {
  private client: OSS;
  private bucket: string;

  /**
   * 构造函数
   * @param config OSS 配置对象
   */
  constructor(config: OssConfig) {
    if (
      !config.region ||
      !config.accessKeyId ||
      !config.accessKeySecret ||
      !config.bucket
    ) {
      throw new Error(
        "OSS 配置缺少必要的参数: region, accessKeyId, accessKeySecret, bucket"
      );
    }

    this.client = new OSS({
      region: config.region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      bucket: config.bucket,
      endpoint: config.endpoint,
      secure: config.secure ?? true, // 默认为 true (HTTPS)
    });
    this.bucket = config.bucket;

    console.log(
      `OSSUtil 已初始化，连接到 Bucket: ${this.bucket}，区域: ${config.region}`
    );
  }

  /**
   * 检查 OSS 文件是否存在
   * @param objectName OSS 上的文件完整路径 (例如: 'path/to/your/file.json')
   * @returns {Promise<boolean>} 如果文件存在返回 true，否则返回 false
   */
  async doesObjectExist(objectName: string): Promise<boolean> {
    try {
      await this.client.head(objectName);
      return true;
    } catch (error: any) {
      if (error.code === "NoSuchKey") {
        return false;
      }
      throw error; // 其他错误仍然抛出
    }
  }

  /**
   * 上传文件或更改文件内容。如果文件不存在则上传，如果存在则覆盖。
   * @param objectName OSS 上的文件完整路径 (例如: 'path/to/your/file.json')
   * @param filePathOrContent 本地文件路径 (string) 或 文件内容 (Buffer/string)
   * @param options 可选的上传选项，例如 { 'Cache-Control': 'no-cache' }
   * @returns {Promise<OSS.PutObjectResult>} 上传结果
   */
  async uploadFile(
    objectName: string,
    filePathOrContent: string | Buffer,
    options?: OSS.PutObjectOptions
  ): Promise<OSS.PutObjectResult> {
    try {
      let result: OSS.PutObjectResult;
      if (
        typeof filePathOrContent === "string" &&
        (await this.isLocalFile(filePathOrContent))
      ) {
        // 如果是本地文件路径
        console.log(
          `正在上传本地文件到 OSS: ${objectName} from ${filePathOrContent}`
        );
        result = await this.client.put(objectName, filePathOrContent, options);
      } else {
        // 如果是文件内容 (字符串或 Buffer)
        console.log(`正在上传内容到 OSS: ${objectName}`);
        result = await this.client.put(
          objectName,
          Buffer.from(filePathOrContent),
          options
        );
      }
      console.log(`文件上传成功: ${objectName}, ETag: ${result}`);
      return result;
    } catch (error) {
      console.error(`文件上传失败: ${objectName}, 错误:`, error);
      throw error;
    }
  }

  /**
   * 获取文件内容
   * @param objectName OSS 上的文件完整路径 (例如: 'path/to/your/file.json')
   * @returns {Promise<string>} 文件内容的字符串形式
   */
  async getFileContent(objectName: string): Promise<string> {
    try {
      console.log(`正在从 OSS 获取文件内容: ${objectName}`);
      const result = await this.client.get(objectName);
      // result.content 是 Buffer 类型，需要转换为字符串
      const content = result.content.toString("utf8");
      console.log(`文件内容获取成功: ${objectName}`);
      return content;
    } catch (error: any) {
      console.error(`获取文件内容失败, 错误:`, error);
      if (error.code === "NoSuchKey") {
        throw new Error(`文件不存在`);
      }
      throw error;
    }
  }

  /**
   * 列出指定目录下所有 JSON 文件
   * @param prefix 目录前缀 (例如: 'lang/'， 注意以 '/' 结尾表示目录)
   * @returns {Promise<{count: number, files: FileInfo[]}>} JSON 文件数量和文件信息列表
   */
  async listJsonFilesInDirectory(
    prefix: string
  ): Promise<{ count: number; files: FileInfo[] }> {
    if (!prefix.endsWith("/")) {
      console.warn(
        `提供的目录前缀 "${prefix}" 没有以 '/' 结尾，建议以 '/' 结尾以确保只列出该目录下的文件。`
      );
    }

    let allJsonFiles: FileInfo[] = [];
    let nextMarker: string | undefined = undefined;

    try {
      do {
        console.log(
          `正在列出目录 ${prefix} 下的文件 (marker: ${nextMarker || "None"})`
        );
        const result: OSS.ListObjectResult = await this.client.list(
          {
            prefix: prefix,
            delimiter: "/", // 用于模拟目录结构，不穿透子目录
            marker: nextMarker,
            "max-keys": 1000,
          },
          {}
        );

        // result.objects 包含当前目录下的文件和子目录 (如果 delimiter 存在)
        if (result.objects) {
          result.objects.forEach((obj) => {
            // 过滤掉子目录，只保留文件，并检查是否是 .json 文件
            if (obj.name.endsWith(".json") && !obj.name.endsWith("/")) {
              // 确保是文件而不是目录
              allJsonFiles.push({
                name: this.getFileName(obj.name),
                size: obj.size,
                lastModified: obj.lastModified,
                etag: obj.etag,
              });
            }
          });
        }
        nextMarker = result.nextMarker; // 获取下一页的起始标记
      } while (nextMarker); // 如果有下一页，继续循环

      console.log(
        `在目录 ${prefix} 下找到 ${allJsonFiles.length} 个 JSON 文件。`
      );
      return {
        count: allJsonFiles.length,
        files: allJsonFiles,
      };
    } catch (error) {
      console.error(`列出目录 ${prefix} 下的 JSON 文件失败，错误:`, error);
      throw error;
    }
  }

  /**
   * 新增方法：列出指定前缀下所有作为版本号的子文件夹。
   * 文件夹名称应为时间戳格式 (YYYYMMDDHHmmss)。
   * @param parentPrefix 父目录前缀，例如 'assets/lang/'
   * @returns {Promise<string[]>} 版本号字符串数组，按时间戳从旧到新排序
   */
  async listLanguageVersions(parentPrefix: string): Promise<string[]> {
    if (!parentPrefix.endsWith("/")) {
      parentPrefix += "/"; // 确保前缀以 '/' 结尾
    }

    let versions: string[] = [];
    let nextMarker: string | undefined = undefined;

    try {
      do {
        console.log(
          `正在列出目录 ${parentPrefix} 下的子目录 (marker: ${
            nextMarker || "None"
          })`
        );
        const result: OSS.ListObjectResult = await this.client.list(
          {
            prefix: parentPrefix,
            delimiter: "/", // 关键：用于获取 CommonPrefixes (子目录)
            marker: nextMarker,
            "max-keys": 1000,
          },
          {}
        );

        // result.prefixes 包含子目录的路径，例如 "assets/lang/20250702115111/"
        if (result.prefixes) {
          result.prefixes.forEach((prefixItem: string) => {
            // 提取文件夹名称 (例如 "20250702115111")
            const folderName = prefixItem
              .substring(parentPrefix.length)
              .replace("/", "");

            // 验证文件夹名是否符合 YYYYMMDDHHmmss 时间戳格式 (14位数字)
            if (/^\d{14}$/.test(folderName)) {
              versions.push(folderName);
            } else {
              console.warn(
                `[OSS] 发现非标准版本号文件夹（跳过）: ${folderName} (完整路径: ${prefixItem})`
              );
            }
          });
        }
        nextMarker = result.nextMarker;
      } while (nextMarker);

      // 根据版本号（时间戳字符串）进行升序排序，确保按时间顺序排列
      versions.sort(); // 字符串的自然排序对于 YYYYMMDDHHmmss 格式是有效的

      console.log(
        `在目录 ${parentPrefix} 下找到 ${versions.length} 个语言版本文件夹。`
      );
      return versions;
    } catch (error) {
      console.error(`列出语言版本文件夹失败 ${parentPrefix}，错误:`, error);
      throw error;
    }
  }
/**
 * 将指定版本目录下的所有文件复制到 current 目录下
 * @param version 要复制到 current 目录下的版本号 (例如 "20251013120000")
 */
async copyVersionToCurrent(version: string): Promise<void> {
  const sourcePrefix = `${OSS_LANG_DIR}${version}/`;
  const targetPrefix = `${OSS_LANG_DIR}current/`;

  console.log(`[OSS] 开始复制版本：${version}`);
  console.log(`[OSS] 源目录：${sourcePrefix}`);
  console.log(`[OSS] 目标目录：${targetPrefix}`);

  try {
    // 1. 列出源目录下所有 JSON 文件
    const { files } = await this.listJsonFilesInDirectory(sourcePrefix);

    if (files.length === 0) {
      console.warn(`[OSS] 版本 ${version} 下未找到任何 JSON 文件，跳过复制。`);
      return;
    }

    // 2. 遍历每个文件并复制到 current 目录
    for (const file of files) {
      const sourceObject = `${sourcePrefix}${file.name}`;
      const targetObject = `${targetPrefix}${file.name}`;

      try {
        await this.client.copy(targetObject, sourceObject);
        console.log(`[OSS] ✅ 已复制: ${file.name}`);
      } catch (err) {
        console.error(`[OSS] ❌ 复制文件失败: ${file.name}`, err);
        throw err;
      }
    }

    console.log(`[OSS] 版本 ${version} 已成功复制到 current 目录，共复制 ${files.length} 个文件。`);
  } catch (error) {
    console.error(`[OSS] 推广版本 ${version} 失败，错误详情:`, error);
    throw error;
  }
}


/**
 * 查找最新的版本号
 */
async  findLatestVersion(): Promise<string | null> {
  try {
    let versions = await this.listLanguageVersions(OSS_LANG_DIR);
    if (!versions || versions.length === 0) return null;
    versions.sort();
    return versions[versions.length - 1];
  } catch (e) {
    console.error("查找最新版本失败:", e);
    return null;
  }
}


  /**
   * 辅助函数：判断给定路径是否为本地文件路径
   * 这是一个简单的判断，你可以根据实际需求调整
   * @param pathString
   * @returns
   */
  private async isLocalFile(pathString: string): Promise<boolean> {
    try {
      const fs = await import("fs"); // 动态导入fs，避免在非node环境下报错
      const stats = fs.statSync(pathString);
      return stats.isFile();
    } catch (e) {
      return false; // 如果文件不存在或不是文件，则认为是内容
    }
  }

  /**
   * 截取文件名
   */
  private getFileName(objectName: string): string {
    return objectName.split("/").pop() || "";
  }
}

// 配置和导出

const OSS_LANG_DIR = "assets/lang/";
// 存储已初始化的 OssUtil 实例的缓存
const ossClients: Map<string, OssUtil> = new Map();

// 从环境变量中获取一次基础 OSS 配置
const baseOssConfig: OssConfig = {
  region: process.env.Vidfly_OSS_REGION!,
  accessKeyId: process.env.Vidfly_OSS_ACCESS_KEY_ID!,
  accessKeySecret: process.env.Vidfly_OSS_ACCESS_KEY_SECRET!,
  bucket: process.env.Vidfly_OSS_BUCKET!,
  secure: true,
};

/**
 * 获取或创建指定项目的 OssUtil 实例（单例模式）
 * @param projectId 项目ID
 * @returns {OssUtil} OssUtil 实例
 */
function getOssUtil(projectId: string | null): OssUtil {
  if (!projectId) {
    throw new Error("projectId 不能为空");
  }
  // 1. 如果缓存中已存在该项目的实例，直接返回
  if (ossClients.has(projectId)) {
    return ossClients.get(projectId)!;
  }

  // 2. 如果不存在，创建新的实例并缓存
  console.log(`[OSS] 为项目 "${projectId}" 创建新的 OssUtil 实例`);
  const newClient = new OssUtil({
    bucket: process.env[`${projectId.toUpperCase()}_OSS_BUCKET`]!,
    region: process.env[`${projectId.toUpperCase()}_OSS_REGION`]!,
    accessKeyId: process.env[`${projectId.toUpperCase()}_OSS_ACCESS_KEY_ID`]!,
    accessKeySecret:
      process.env[`${projectId.toUpperCase()}_OSS_ACCESS_KEY_SECRET`]!,
    secure: true,
  });

  ossClients.set(projectId, newClient);
  return newClient;
}

export { getOssUtil, OSS_LANG_DIR };
