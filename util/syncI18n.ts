import { logChanges } from "./logger";
import { translator } from "./translator";
import { getOssUtil, OSS_LANG_DIR, OssUtil } from "./oss";
import { isJsonChanged, unflattenJSON, flatten, chunkArray } from ".";
import {
  createCommitIdVersionMapping,
  getPendingPromoteRequests,
  removePromoteRequest,
  getLangVersionByCommitId,
} from "./versioning";
import { retryGetFile, retryGetLanguageFile, withRetry } from "./retry";

interface SyncI18nOptions {
  currentVersion: string; // 当前版本 --- 准备上传的版本
  uploadedEnJsonContent: string | null; // 从 /update-lang 传入的 en.json 内容
  projectId: string | null; // 从 /update-lang 传入的项目 ID
  promoteToCurrent: boolean; // 是否在同步成功后自动复制到 current 目录
  commitId: string | null; // 从 /update-lang 传入的提交 ID
}

export async function run({
  currentVersion,
  uploadedEnJsonContent,
  projectId,
  promoteToCurrent,
  commitId,
}: SyncI18nOptions) {
  console.log(`[syncI18n] 开始执行多语言同步，版本号: ${currentVersion}`);

  let latestVersion: string | null = null; // 最新版本 --- oss目录下的
  let ossUtil: OssUtil | null = null;

  // --- 初始化 OssUtil ---
  try {
    ossUtil = getOssUtil(projectId);
  } catch (error) {
    console.error("初始化 OssUtil 失败", error);
    throw error;
  }

  // --- 获取最新版本 ---
  try {
    const versions = await ossUtil.listLanguageVersions(OSS_LANG_DIR);
    if (versions.includes(currentVersion)) {
      throw new Error(
        `[syncI18n] 版本号 ${currentVersion} 已存在，请更换一个版本号。`
      );
    }
    if (versions.length > 0) {
      latestVersion = versions[versions.length - 1];
    }
  } catch (error) {
    console.error("获取版本列表失败", error);
    throw error;
  }

  const OSS_VERSIONED_LANG_DIR = `${OSS_LANG_DIR}${currentVersion}/`; // 上传版本目录 --- oss还并不存在
  const OSS_LATEST_LANG_DIR = `${OSS_LANG_DIR}${latestVersion}/`; // 当前 OSS 上已有的最新版本
  const OSS_CURRENT_LANG_DIR = `${OSS_LANG_DIR}current/`; // current 目录
  const CHUNK_SIZE = 50; // 设置每个翻译批次的键数量阈值，例如500个键 --- 防止新增的key过于多导致json内容过于庞大

  // --- 1. 获取基准 en.json 文件内容 ---
  let currentEnJsonContent: Record<string, any>;
  if (uploadedEnJsonContent) {
    // 如果传入了上传的 en.json 内容，则使用它作为当前 en.json
    currentEnJsonContent = JSON.parse(uploadedEnJsonContent);
    console.log("[syncI18n] 使用从参数传入的 en.json 内容作为当前版本。");
  } else {
    // 否则，从 OSS 下载 en.json 作为当前 en.json
    console.log("[syncI18n] 从 OSS 下载 en.json 作为当前版本。");
    const latestEnJson = await ossUtil.getFileContent(
      `${OSS_LATEST_LANG_DIR}en.json`
    );
    if (!latestEnJson) {
      throw new Error("OSS 上找不到 en.json，无法进行比对。");
    }
    currentEnJsonContent = JSON.parse(latestEnJson);
  }

  // --- 2. 获取 oss 上一个版本 en.json 文件内容 ---
  console.log("[syncI18n] 从 OSS 下载 en.stable.json 进行比对。");

  let stableEnJsonContent: Record<string, any> = {}; // 前一个版本

  try {
    const stableCurrentVersionEnJson = await retryGetFile(
      () => ossUtil.getFileContent(`${OSS_CURRENT_LANG_DIR}en.json`),
      `${OSS_CURRENT_LANG_DIR}en.json`
    ); // current 目录的 en.json 文件内容

    // --- 2.1. 获取 current 目录的 en.json 文件内容 ---
    if (stableCurrentVersionEnJson) {
      stableEnJsonContent = JSON.parse(stableCurrentVersionEnJson);
    } else if (latestVersion) {
      // --- 2.2. 获取上一个版本的 en.json 文件内容 ---
      const stableLastVersionEnJson = await retryGetFile(
        () => ossUtil.getFileContent(`${OSS_LATEST_LANG_DIR}en.json`),
        `${OSS_LATEST_LANG_DIR}en.json`
      );
      stableEnJsonContent = JSON.parse(stableLastVersionEnJson);
    }
  } catch (error) {
    console.error("获取 en.stable.json 失败,初始化为空对象", error);
    // throw error;
  }

  // --- 3. 差异比对 ---
  // 这里使用 flatten 将所有嵌套键值对都拉平，方便逐键对比。
  const flatEn = flatten(currentEnJsonContent);
  const flatEnOld = flatten(stableEnJsonContent);

  const isChanged = isJsonChanged(flatEn, flatEnOld);

  if (!isChanged) {
    console.log(
      "[syncI18n] en.json 与 en.stable.json 无任何变化，跳过多语言同步。"
    );
    return;
  }

  // --- 4. 处理新增和修改的字段（触发翻译） ---
  let langFiles: string[] = [
    "da",
    "de",
    "es",
    "fr",
    "id",
    "it",
    "ja",
    "ko",
    "nb",
    "nl",
    "pl",
    "pt",
    "ru",
    "th",
    "tr",
    "tw",
    "zh",
  ];
  const allUpdatedLangContents: { [lang: string]: string } = {}; // 用于暂存所有语言的更新内容，等待所有处理完成后再统一上传

  // 获取所有 lang 文件（排除 en/en_stable）
  try {
    const res = await ossUtil.listJsonFilesInDirectory(OSS_CURRENT_LANG_DIR);
    if (res) {
      const files = res.files
        .map((f) => f.name)
        .filter((f) => !["en.json", "en_stable.json"].includes(f));
      if (files.length > 0) {
        langFiles = files;
      }
    }
  } catch (error) {
    console.error("获取所有 lang 文件失败", error);
  }

  if (langFiles.length === 0) {
    console.error("没有找到 lang 文件");
    return;
  }

  const langs = langFiles.map((f) => f.replace(/\.json$/, "")); // 获取所有语言文件名

  // 将语言文件名映射为更清晰的目标语言描述，避免模型误判（例如 tw 被当作 Twi）
  const getTargetLangForModel = (lang: string): string => {
    switch (lang) {
      case "tw":
        // 明确指定为台湾繁体中文，而不是 ISO 639-1 的 Twi 语言
        return "Traditional Chinese (Taiwan)";
      case "zh":
        // 这里根据你的实际需求调整，如果 zh 表示简体中文，可以写清楚
        return "Simplified Chinese";
      default:
        return lang;
    }
  };

  console.log(langs, "langs");

  // 定义单个语言的翻译处理函数
  const processSingleLang = async (lang: string) => {
    const startTime = new Date();
    console.log(`\n🚀 开始同步 [${lang}] ${startTime.toLocaleString()}`);

    let targetLangJsonContent: Record<string, any> = {}; // 目标语言 JSON 内容
    try {
      // 采取降级处理
      const { content, isFallback, isFileNotFound } =
        await retryGetLanguageFile(
          () => ossUtil.getFileContent(`${OSS_CURRENT_LANG_DIR}${lang}.json`),
          latestVersion
            ? () => ossUtil.getFileContent(`${OSS_LATEST_LANG_DIR}${lang}.json`)
            : null,
          lang,
          { maxRetries: 3, retryDelay: 1000 }
        );
      targetLangJsonContent = content;
    } catch (err) {
      console.warn(`⚠️ 未找到 ${lang}.json 文件，已创建空对象替代`);
      targetLangJsonContent = {};
    }

    // 将目标语言文件也拍平，以便进行增量合并
    const flatTargetLang = flatten(targetLangJsonContent);
    const updatedFlatTargetLang: Record<string, any> = { ...flatTargetLang };

    const changes = {
      added: [] as string[],
      updated: [] as string[],
      removed: [] as string[],
    };

    const keysToTranslate: string[] = [];

    // --- 找出所有需要翻译的新增和修改的键 ---
    for (const key in flatEn) {
      if (
        !Object.prototype.hasOwnProperty.call(flatEnOld, key) ||
        flatEn[key] !== flatEnOld[key]
      ) {
        if (!Object.prototype.hasOwnProperty.call(flatEnOld, key)) {
          changes.added.push(key);
        } else {
          changes.updated.push(key);
        }
        keysToTranslate.push(key);
      } else {
        if (Object.prototype.hasOwnProperty.call(flatTargetLang, key)) {
          updatedFlatTargetLang[key] = flatTargetLang[key];
        } else {
          // 如果没有变化但目标语言中没有，也放入待翻译列表
          keysToTranslate.push(key);
        }
      }
    }

    // --- 批量翻译需要处理的键 ---
    if (keysToTranslate.length > 0) {
      console.log(
        `--- 正在翻译 ${lang} 的 ${keysToTranslate.length} 个键... ---`
      );

      // 将需要翻译的键数组分成小块
      const keyChunks = chunkArray(keysToTranslate, CHUNK_SIZE);

      for (const chunk of keyChunks) {
        // 构建一个只包含需要翻译的键值对的 JSON 对象
        const jsonToTranslate: Record<string, any> = {};
        for (const key of chunk) {
          jsonToTranslate[key] = flatEn[key];
        }

        try {
          const translatedJsonString =
            await translator.translateSingleJsonChunk(
              JSON.stringify(jsonToTranslate, null, 2),
              getTargetLangForModel(lang)
            );
          const translatedFlatJson = JSON.parse(translatedJsonString);

          // 将翻译结果合并到更新后的目标语言扁平对象中
          for (const key in translatedFlatJson) {
            updatedFlatTargetLang[key] = translatedFlatJson[key];
          }
        } catch (error) {
          console.error(`❌ 翻译 JSON 片段失败，将使用原始英文片段。`, error);
          // 翻译失败时，将英文原文合并进去
          for (const key of chunk) {
            updatedFlatTargetLang[key] = flatEn[key];
          }
        }
      }
    }

    // 🔥 找出 en.json 中已移除的键，并在目标语言中也移除
    for (const key in flatEnOld) {
      if (!Object.prototype.hasOwnProperty.call(flatEn, key)) {
        delete updatedFlatTargetLang[key];
        changes.removed.push(key);
      }
    }

    // 将拍平后的对象还原成嵌套 JSON
    const updatedTargetLangJson = unflattenJSON(updatedFlatTargetLang);
    const prettyJson = JSON.stringify(updatedTargetLangJson, null, 2);
    logChanges(lang, changes);

    allUpdatedLangContents[lang] = prettyJson; // 将处理后的内容存储在内存中，不立即上传

    const endTime = new Date();
    console.log(
      `🚀 同步完成 [${lang}]
开始时间: ${startTime.toLocaleString()}
结束时间: ${endTime.toLocaleString()}
耗时: ${(endTime.getTime() - startTime.getTime()) / 1000}s`
    );
  };

  // 并发翻译，每次最多处理5个语言
  const CONCURRENT_LIMIT = 17;
  const langChunks = chunkArray(langs, CONCURRENT_LIMIT);

  console.log(
    `\n📦 共 ${langs.length} 个语言，分为 ${langChunks.length} 批次，每批最多 ${CONCURRENT_LIMIT} 个语言并发翻译\n`
  );

  for (let i = 0; i < langChunks.length; i++) {
    const chunk = langChunks[i];
    console.log(
      `\n🔄 开始处理第 ${i + 1}/${langChunks.length} 批次: [${chunk.join(
        ", "
      )}]`
    );

    try {
      // 并发处理当前批次的所有语言
      await Promise.all(chunk.map((lang) => processSingleLang(lang)));
      console.log(`✅ 第 ${i + 1}/${langChunks.length} 批次处理完成\n`);
    } catch (error) {
      console.error(`❌ 第 ${i + 1}/${langChunks.length} 批次处理失败:`, error);
      // 继续处理下一批次
    }
  }

  // --- 6. 统一上传所有处理完成的语言文件 ---
  console.log(
    `\n☁️ 开始统一上传所有语言文件到 OSS 版本目录: ${currentVersion}`
  );
  for (const lang of langs) {
    const content = allUpdatedLangContents[lang]; // 同步后的语言
    if (content) {
      const ossPath = `${OSS_VERSIONED_LANG_DIR}${lang}.json`;
      try {
        // 使用 withRetry 进行重试
        await withRetry(async () => ossUtil.uploadFile(ossPath, content));
        console.log(`✅ 已上传 ${lang}.json 到 ${ossPath}`);
      } catch (error: any) {
        console.error(
          `❌ 上传 ${lang}.json 失败到 ${ossPath}，错误：${
            error?.message || "error"
          }`
        );
        // 如果这里上传失败，根据严格原子性原则，应该回滚或抛出致命错误
        throw error; // 严格中断，如果单个文件上传失败
      }
    } else {
      console.warn(`⚠️ 未找到 ${lang} 的处理内容，跳过上传。`);
    }
  }

  // --- 7. 更新 OSS 上传版本的 en.json ---
  try {
    const ossPath = `${OSS_VERSIONED_LANG_DIR}en.json`;
    await withRetry(async () =>
      ossUtil.uploadFile(ossPath, JSON.stringify(currentEnJsonContent, null, 2))
    );
    console.log("en.json 已更新。");
  } catch (error) {
    console.error("上传 en.json 失败", error);
  }

  // --- 8. 自动复制到 current 目录 ---
  if (promoteToCurrent) {
    await ossUtil.copyVersionToCurrent(currentVersion);
  }

  // --- 9. 建立 Commit ID 与 Lang Version 的映射 ---
  if (commitId) {
    await createCommitIdVersionMapping(commitId, currentVersion);
  }

  // --- 10. 检查并执行待推广请求 ---
  await processPendingPromoteRequests(ossUtil, currentVersion, projectId);
}

/**
 * 处理待推广请求
 * 检查是否有待推广的请求，如果有且对应的版本已完成翻译，则自动执行推广
 */
async function processPendingPromoteRequests(
  ossUtil: OssUtil,
  currentVersion: string,
  projectId: string | null
): Promise<void> {
  try {
    // 只获取当前项目的待推广请求
    const pendingRequests = await getPendingPromoteRequests(
      projectId || undefined
    );

    if (pendingRequests.length === 0) {
      console.log("[syncI18n] 没有待推广的请求");
      return;
    }

    console.log(
      `[syncI18n] 发现 ${pendingRequests.length} 个待推广请求，开始处理...`
    );

    for (const request of pendingRequests) {
      try {
        // 检查项目 ID 是否匹配
        if (projectId && request.projectId !== projectId) {
          console.log(
            `[syncI18n] 推广请求 ${request.commitId} 项目 ID 不匹配，跳过`
          );
          continue;
        }

        // 检查当前版本是否与请求的 commitId 匹配
        const requestVersion = await getLangVersionByCommitId(request.commitId);

        if (requestVersion === currentVersion) {
          // 检查当前版本是否完整（包含所有必要的语言文件）
          const { files } = await ossUtil.listJsonFilesInDirectory(
            `${OSS_LANG_DIR}${currentVersion}/`
          );

          // 检查版本完整性：至少应该包含 en.json 和其他语言文件
          const hasEnFile = files.some((f) => f.name === "en.json");
          const hasOtherLangFiles = files.some(
            (f) => f.name !== "en.json" && f.name.endsWith(".json")
          );

          if (hasEnFile && hasOtherLangFiles && files.length > 1) {
            console.log(
              `[syncI18n] 版本 ${currentVersion} 翻译完成，自动推广到 current 目录`
            );
            await ossUtil.copyVersionToCurrent(currentVersion);
            await removePromoteRequest(request.commitId);
            console.log(
              `[syncI18n] 已处理推广请求: ${request.commitId} -> ${currentVersion}`
            );
          } else {
            console.log(
              `[syncI18n] 版本 ${currentVersion} 不完整（文件数: ${files.length}），跳过推广`
            );
          }
        } else {
          console.log(
            `[syncI18n] 推广请求 ${request.commitId} 对应的版本 ${requestVersion} 与当前版本 ${currentVersion} 不匹配，跳过`
          );
        }
      } catch (error) {
        console.error(
          `[syncI18n] 处理推广请求失败: ${request.commitId}`,
          error
        );
      }
    }
  } catch (error) {
    console.error("[syncI18n] 处理待推广请求时发生错误", error);
  }
}
