import { run as syncI18n } from "./syncI18n";
import { generateTimestampVersion } from "./versioning";

/**
 * 这是一个被 Express 父进程 `fork` 调用的脚本。
 * 它负责生成版本号，并触发核心的多语言同步逻辑。
 */
async function executeSync() {
  try {
    // --- 1. 解析传入的 en.json 内容 (如果通过 --en-json-content 参数传入) ---
    let enJsonStringFromArg: string | null = null;
    const enJsonContentIndex = process.argv.indexOf("--en-json-content");

    if (enJsonContentIndex > -1 && process.argv[enJsonContentIndex + 1]) {
      try {
        // Base64 解码传入的 JSON 内容
        enJsonStringFromArg = Buffer.from(
          process.argv[enJsonContentIndex + 1],
          "base64"
        ).toString("utf-8");
      } catch (error) {
        console.error(
          "[runI18nSync] 无法解析传入的 en.json 内容:",
          (error as Error).message
        );
        process.exit(1);
      }
    }

    // --- 2. 解析传入的 projectId ---
    let projectId: string | null = null;
    const projectIdIndex = process.argv.indexOf("--project-id");
    if (projectIdIndex > -1 && process.argv[projectIdIndex + 1]) {
      projectId = process.argv[projectIdIndex + 1];
      console.log(`[runI18nSync] 接收到项目 ID: ${projectId}`);
    } else {
      console.warn(`[runI18nSync] 没有接收到项目 ID，将使用默认 OSS 路径`);
    }

    // --- 3. 生成当前时间戳作为版本号 ---
    const currentVersion = generateTimestampVersion();
    console.log(`[runI18nSync] 本次同步任务的版本号: ${currentVersion}`);

    console.log(`[${projectId}] 子进程：开始执行多语言同步...`);
    await syncI18n({
      currentVersion,
      uploadedEnJsonContent: enJsonStringFromArg,
      projectId,
    });
    console.log(
      `[runI18nSync] 多语言同步任务 (版本: ${currentVersion}) 已完成。`
    );
    process.exit(0); // 成功退出
  } catch (error: any) {
    console.error(
      `[runI18nSync] 多语言同步任务失败:`,
      (error as Error).message
    );
    process.exit(1); // 失败退出
  }
}

executeSync();
