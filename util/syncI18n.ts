import { flatten, isJsonChanged, unflattenJSON } from ".";
import { logChanges } from "./logger";
import { translator } from "./translator";
import { ossUtil, OSS_LANG_DIR } from "./oss";

interface SyncI18nOptions {
  currentVersion: string; // 当前版本 --- 准备上传的版本
  uploadedEnJsonContent: string | null; // 从 /update-lang 传入的 en.json 内容
}

export async function run({
  currentVersion,
  uploadedEnJsonContent,
}: SyncI18nOptions) {
  console.log(`[syncI18n] 开始执行多语言同步，版本号: ${currentVersion}`);

  let latestVersion: string | null = null; // 最新版本 --- oss目录下的

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
    if (latestVersion) {
      // 上一个版本存在 --- 取上一个版本的 en.json
      const stableLastVersionEnJson = await ossUtil.getFileContent(
        `${OSS_LATEST_LANG_DIR}en.json`
      );
      stableEnJsonContent = JSON.parse(stableLastVersionEnJson);
    } else {
      // 上一个版本不存在 --- 取根目录的
      const stableDirVersionEnJson = await ossUtil.getFileContent(
        `${OSS_LANG_DIR}en.json`
      );
      stableEnJsonContent = JSON.parse(stableDirVersionEnJson);
    }
  } catch (error) {
    console.error("获取 en.stable.json 失败", error);
    throw error;
  }

  // --- 3. 差异比对 ---
  // 这里我们不再直接使用 flatten/unflatten 进行逐条对比，
  // 而是会逐个顶层键进行 JSON 段的翻译和合并。
  // 但是 `isJsonChanged` 仍然可以用来判断整体 en.json 是否需要处理。
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
  let langFiles: string[] = [];
  const allUpdatedLangContents: { [lang: string]: string } = {};// 用于暂存所有语言的更新内容，等待所有处理完成后再统一上传

  // 获取所有 lang 文件（排除 en/en_stable）
  try {
    const res = await ossUtil.listJsonFilesInDirectory(OSS_LATEST_LANG_DIR);
    if (res) {
      langFiles = res.files
        .map((f) => f.name)
        .filter((f) => !["en.json", "en_stable.json"].includes(f));
    }
  } catch (error) {
    console.error("获取所有 lang 文件失败", error);
  }

  if (langFiles.length === 0) {
    console.error("没有找到 lang 文件");
    return;
  }

  const langs = langFiles.map((f) => f.replace(/\.json$/, "")); // 获取所有语言文件名

  console.log(langs, "langs");

  for (const lang of langs) {
    const startTime = new Date();
    console.log(`\n🚀 开始同步 [${lang}] ${startTime.toLocaleString()}`);

    let targetLangJsonContent: Record<string, any>; // 目标语言 JSON 内容
    try {
      const jsonStr = await ossUtil.getFileContent(
        `${OSS_LATEST_LANG_DIR}${lang}.json`
      );
      if (!jsonStr.trim()) {
        console.warn(`⚠️  ${lang}.json 是空文件，已使用空对象替代`);
        targetLangJsonContent = {};
      } else {
        targetLangJsonContent = JSON.parse(jsonStr);
      }
    } catch (err) {
      console.warn(`⚠️ 未找到 ${lang}.json 文件，已创建空对象替代`);
      targetLangJsonContent = {};
    }

    const updatedTargetLangJson: Record<string, any> = { ...targetLangJsonContent }; // 更新后的目标语言 JSON 内容
    const changes = {
      added: [] as string[],
      updated: [] as string[],
      removed: [] as string[],
    };

    // 遍历 en.json 的顶层键，进行逐段翻译
    for (const topLevelKey in currentEnJsonContent) {
      if (Object.prototype.hasOwnProperty.call(currentEnJsonContent, topLevelKey)) {
        const enSection = { [topLevelKey]: currentEnJsonContent[topLevelKey] }; // 提取当前顶层键对应的 JSON 片段
        const enOldSection = { [topLevelKey]: stableEnJsonContent[topLevelKey] };

        // 检查这一段英文 JSON 是否有变化
        const flatEnSection = flatten(enSection);
        const flatEnOldSection = flatten(enOldSection);

        // 如果这一段英文 JSON 是新的或者有变化，则进行翻译
        if (!Object.prototype.hasOwnProperty.call(stableEnJsonContent, topLevelKey) || isJsonChanged(flatEnSection, flatEnOldSection)) {
          console.log(`--- 正在翻译 ${lang} 的片段: ${topLevelKey} ---`);
          try {
            const translatedSectionJsonString = await translator.translateSingleJsonChunk(
              JSON.stringify(enSection, null, 2), // 传入格式化的 JSON 片段
              lang
            );
            const translatedSection = JSON.parse(translatedSectionJsonString);
            // 将翻译后的片段合并到总的目标语言 JSON 对象中
            updatedTargetLangJson[topLevelKey] = translatedSection[topLevelKey];

            // 记录变化（这里可能需要更细致的记录，例如记录具体哪个内部的key发生了变化）
            // 目前简化为如果整个段落被翻译/更新，就记录顶层key
            if (!Object.prototype.hasOwnProperty.call(targetLangJsonContent, topLevelKey)) {
              changes.added.push(topLevelKey);
            } else {
              changes.updated.push(topLevelKey);
            }

          } catch (error) {
            console.error(`❌ 翻译 JSON 片段 "${topLevelKey}" 失败，将使用原始英文片段。`, error);
            // 翻译失败时，保留原始英文值或旧的目标语言值（如果存在）
            updatedTargetLangJson[topLevelKey] = targetLangJsonContent[topLevelKey] || currentEnJsonContent[topLevelKey];
          }
        } else {
          // 如果英文片段没有变化，则直接保留目标语言中对应的旧值
          updatedTargetLangJson[topLevelKey] = targetLangJsonContent[topLevelKey];
        }
      }
    }

    // 🔥 删除 en.json 中已经移除的顶层 key
    for (const topLevelKey in targetLangJsonContent) {
      if (Object.prototype.hasOwnProperty.call(targetLangJsonContent, topLevelKey)) {
        if (!Object.prototype.hasOwnProperty.call(currentEnJsonContent, topLevelKey)) {
          delete updatedTargetLangJson[topLevelKey];
          changes.removed.push(topLevelKey);
        }
      }
    }

    const prettyJson = JSON.stringify(updatedTargetLangJson, null, 2);
    logChanges(lang, changes);

    allUpdatedLangContents[lang] = prettyJson; // 将处理后的内容存储在内存中，不立即上传

    // try {
    //   const ossPath = `${OSS_VERSIONED_LANG_DIR}${lang}.json`;
    //   await ossUtil.uploadFile(ossPath, prettyJson);
    // } catch (error) {
    //   console.error("上传目标语言文件失败", error);
    //   throw error;
    // }

    const endTime = new Date();
    console.log(
      `🚀 同步完成 [${lang}]
开始时间: ${startTime.toLocaleString()}
结束时间: ${endTime.toLocaleString()}
耗时: ${(endTime.getTime() - startTime.getTime()) / 1000}s`
    );
  }

  // --- 6. 统一上传所有处理完成的语言文件 ---
  console.log(`\n☁️ 开始统一上传所有语言文件到 OSS 版本目录: ${currentVersion}`);
  for (const lang of langs) {
    const content = allUpdatedLangContents[lang]; // 同步后的语言
    if (content) {
      const ossPath = `${OSS_VERSIONED_LANG_DIR}${lang}.json`;
      try {
        await ossUtil.uploadFile(ossPath, content);
        console.log(`✅ 已上传 ${lang}.json 到 ${ossPath}`);
      } catch (error: any) {
        console.error(`❌ 上传 ${lang}.json 失败到 ${ossPath}，错误：${error?.message || 'error'}`);
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
    await ossUtil.uploadFile(
      ossPath,
      JSON.stringify(currentEnJsonContent, null, 2)
    );
    console.log("en.json 已更新。");
  } catch (error) {
    console.error("上传 en.json 失败", error);
  }
}