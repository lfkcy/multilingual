/**
 * 重试配置接口
 */
interface RetryConfig {
  maxRetries?: number; // 最大重试次数，默认为3
  retryDelay?: number; // 重试间隔（毫秒），默认为1000
  backoffMultiplier?: number; // 退避乘数，默认为2（指数退避）
  maxDelay?: number; // 最大延迟时间（毫秒），默认为10000
  shouldRetry?: (error: any) => boolean; // 自定义重试条件函数
}

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  retryDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 10000,
  shouldRetry: (error: any) => {
    // 默认重试条件：不是文件不存在错误
    return !(
      error.code === "NoSuchKey" ||
      (error.message && error.message.includes("文件不存在"))
    );
  },
};

/**
 * 通用重试函数
 * @param fn 需要重试的异步函数
 * @param config 重试配置
 * @returns Promise<T> 函数执行结果
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any;
  let currentDelay = finalConfig.retryDelay;

  for (let attempt = 1; attempt <= finalConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // 检查是否应该重试
      if (!finalConfig.shouldRetry(error)) {
        throw error;
      }

      // 如果是最后一次尝试，直接抛出错误
      if (attempt === finalConfig.maxRetries) {
        break;
      }

      // 等待后重试
      console.log(
        `🔄 重试 ${attempt}/${finalConfig.maxRetries}，等待 ${currentDelay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, currentDelay));

      // 计算下次重试的延迟时间（指数退避，但有上限）
      currentDelay = Math.min(
        currentDelay * finalConfig.backoffMultiplier,
        finalConfig.maxDelay
      );
    }
  }

  // 所有重试都失败了
  console.error(`❌ 重试失败，已尝试 ${finalConfig.maxRetries} 次`, lastError);
  throw lastError;
}

/**
 * 专门用于OSS文件获取的重试函数
 * @param getFileFn 获取文件的函数
 * @param fileName 文件名（用于日志）
 * @param config 重试配置
 * @returns Promise<string> 文件内容
 */
export async function retryGetFile(
  getFileFn: () => Promise<string>,
  fileName: string,
  config: RetryConfig = {}
): Promise<string> {
  return withRetry(
    async () => {
      console.log(`📥 正在获取文件: ${fileName}`);
      const content = await getFileFn();
      console.log(`✅ 成功获取文件: ${fileName}`);
      return content;
    },
    {
      ...config,
      shouldRetry: (error: any) => {
        // OSS文件获取的重试条件：不是文件不存在错误
        const isFileNotFound =
          error.message && error.message.includes("文件不存在");
        const isNoSuchKey = error.code === "NoSuchKey";

        if (isFileNotFound || isNoSuchKey) {
          console.log(`📄 文件不存在: ${fileName}，不进行重试`);
          return false;
        }

        console.warn(`⚠️ 获取文件失败: ${fileName}，将重试`, error.message);
        return true;
      },
    }
  );
}

/**
 * 专门用于处理语言文件获取的重试函数
 * 包含降级策略
 * @param primaryGetFn 主要获取函数（从current目录）
 * @param fallbackGetFn 降级获取函数（从其他版本）
 * @param lang 语言代码
 * @param config 重试配置
 * @returns Promise<{content: Record<string, any>, isFallback: boolean}>
 */
export async function retryGetLanguageFile(
  primaryGetFn: () => Promise<string>,
  fallbackGetFn: (() => Promise<string>) | null,
  lang: string,
  config: RetryConfig = {}
): Promise<{
  content: Record<string, any>;
  isFallback: boolean;
  isFileNotFound: boolean;
}> {
  let isFileNotFound = false;
  let isFallback = false;
  let content: Record<string, any> = {};

  try {
    // 尝试主要获取方式
    const jsonStr = await retryGetFile(primaryGetFn, `${lang}.json`, config);
    content = jsonStr.trim() ? JSON.parse(jsonStr) : {};
    console.log(`✅ 成功从主要源获取 ${lang}.json`);
  } catch (error: any) {
    // 检查是否为文件不存在
    if (
      error.code === "NoSuchKey" ||
      (error.message && error.message.includes("文件不存在"))
    ) {
      console.warn(`⚠️ ${lang}.json 文件不存在，将创建新文件`);
      isFileNotFound = true;
      content = {};
    } else {
      // 网络错误，尝试降级策略
      console.error(`❌ 获取 ${lang}.json 失败，尝试降级策略:`, error.message);

      if (fallbackGetFn) {
        try {
          console.log(`🔄 尝试从降级源获取 ${lang}.json`);
          const fallbackJsonStr = await retryGetFile(
            fallbackGetFn,
            `${lang}.json (降级)`,
            config
          );
          content = fallbackJsonStr.trim() ? JSON.parse(fallbackJsonStr) : {};
          isFallback = true;
          console.log(`✅ 成功从降级源获取 ${lang}.json`);
        } catch (fallbackError) {
          console.error(`❌ 降级获取也失败:`, fallbackError);
          content = {};
        }
      } else {
        content = {};
        console.log(
          `⏭️ 无法获取 ${lang}.json 且无降级策略，请检查网络连接或文件是否存在`
        );
      }
    }
  }

  return { content, isFallback, isFileNotFound };
}

/**
 * 批量重试函数，用于处理多个异步操作
 * @param operations 操作数组
 * @param config 重试配置
 * @returns Promise<Array<{success: boolean, result?: T, error?: any}>>
 */
export async function retryBatch<T>(
  operations: Array<() => Promise<T>>,
  config: RetryConfig = {}
): Promise<
  Array<{ success: boolean; result?: T; error?: any; index: number }>
> {
  const results: Array<{
    success: boolean;
    result?: T;
    error?: any;
    index: number;
  }> = [];

  for (let i = 0; i < operations.length; i++) {
    try {
      const result = await withRetry(operations[i], config);
      results.push({ success: true, result, index: i });
    } catch (error) {
      results.push({ success: false, error, index: i });
    }
  }

  return results;
}

export default {
  withRetry,
  retryGetFile,
  retryGetLanguageFile,
  retryBatch,
};
