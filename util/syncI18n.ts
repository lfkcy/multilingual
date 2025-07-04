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
  const flatEn = flatten(currentEnJsonContent); // 拍平后的英语
  const flatEnOld = flatten(stableEnJsonContent); // 拍平后的旧英语

  // 判断 en.json 是否有变化
  const isChanged = isJsonChanged(flatEn, flatEnOld);

  // 不生成新版本目录
  if (!isChanged) {
    console.log(
      "[syncI18n] en.json 与 en.stable.json 无任何变化，跳过多语言同步。"
    );
    return;
  }

  // --- 4. 处理新增和修改的字段（触发翻译） ---
  let langFiles: string[] = [];

  // 获取所有 lang 文件（排除 en/en_stable）
  try {
    console.log(OSS_LATEST_LANG_DIR, "???");

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

  const langs = langFiles.map((f) => f.replace(/\.json$/, ""));

  console.log(langs, "langs");

  for (const lang of langs) {
    const startTime = new Date();
    console.log(`\n🚀 开始同步 [${lang}] ${startTime.toLocaleString()}`);

    let json: string;
    try {
      json = await ossUtil.getFileContent(`${OSS_LATEST_LANG_DIR}${lang}.json`);
      if (!json.trim()) {
        // 防止 json 文件是空字符串
        console.warn(`⚠️  ${lang}.json 是空文件，已使用空对象替代`);
        json = "{}";
      }
    } catch (err) {
      console.warn(`⚠️ 未找到 ${lang}.json 文件，已创建空对象替代`);
      json = "{}";
    }

    const flatLang = flatten(JSON.parse(json)); // 拍平后的目标语言
    const updatedLang: Record<string, string> = { ...flatLang }; // 用一个新对象来存储更新后的语言

    const changes = {
      added: [] as string[],
      updated: [] as string[],
      removed: [] as string[],
    };

    for (const key in flatEn) {
      const newValue = flatEn[key]; // 新语言(英语)
      const enOldValue = flatEnOld[key]; // 旧语言(英语)
      const langValue = flatLang[key]; // 目标语言

      if (!langValue) {
        // 如果目标语言不存在，则添加目标语言 --- 调用翻译方法
        const translateValue = await translator.translate(newValue, lang);
        if (translateValue) {
          updatedLang[key] = translateValue;
          changes.added.push(key);
        }
      } else if (enOldValue !== newValue) {
        // 如果旧语言和目标语言不一致，则更新目标语言 --- 调用翻译方法
        const translateValue = await translator.translate(newValue, lang);
        if (translateValue) {
          updatedLang[key] = translateValue;
          changes.updated.push(key);
        }
      }
    }

    // 🔥 删除 en.json 中已经移除的 key
    for (const key in flatLang) {
      if (!(key in flatEn)) {
        delete updatedLang[key];
        changes.removed.push(key);
      }
    }

    const nestedLang = unflattenJSON(updatedLang); // 将拍平后的目标语言转换为嵌套的 JSON 对象
    const prettyJson = JSON.stringify(nestedLang, null, 2); // 将嵌套的 JSON 对象转换为格式化的 JSON 字符串
    logChanges(lang, changes); // 记录变化

    try {
      const ossPath = `${OSS_VERSIONED_LANG_DIR}${lang}.json`;
      await ossUtil.uploadFile(ossPath, prettyJson);
    } catch (error) {
      console.error("上传目标语言文件失败", error);
      throw error;
    }

    const endTime = new Date();
    console.log(
      `🚀 同步完成 [${lang}]
开始时间: ${startTime.toLocaleString()}
结束时间: ${endTime.toLocaleString()}
耗时: ${(endTime.getTime() - startTime.getTime()) / 1000}s`
    );
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
