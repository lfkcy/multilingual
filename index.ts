import fs from "fs";
import { Command } from "commander";
import { flatten, unflattenJSON } from "./util";
import { logChanges } from "./util/logger";
import path from "path";
import { translate } from "./util/translator";

export async function run() {
  const program = new Command();
  program
    .option("--langs <langs>", "语言列表,逗号分隔，例如: zh,ja,es")
    .parse(process.argv);

  const opts = program.opts();
  const langs = opts.langs.split(",").map((l: string) => l.trim());

  console.log(langs, "langs");

  const enJson = fs.readFileSync("./lang/en.json", "utf-8"); // 本地最新版本的英语
  const enOldJson = fs.readFileSync("./lang/en_stable.json", "utf-8"); // 本地旧版本的英语
  const flatEn = flatten(JSON.parse(enJson));
  const flatEnOld = flatten(JSON.parse(enOldJson));

  for (const lang of langs) {
    const startTime = new Date();
    console.log(`\n🚀 开始同步 [${lang}] ${startTime.toLocaleString()}`);

    let json: string;
    try {
      json = fs.readFileSync(`./lang/${lang}.json`, "utf-8");
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
        const translateValue = await translate(newValue, lang);
        if (translateValue) {
          updatedLang[key] = translateValue;
          changes.added.push(key);
        }
        // changes.added.push(key);
      } else if (enOldValue !== newValue) {
        // 如果旧语言和目标语言不一致，则更新目标语言 --- 调用翻译方法
        const translateValue = await translate(newValue, lang);
        if (translateValue) {
          updatedLang[key] = translateValue;
          changes.updated.push(key);
        }
        // changes.updated.push(key);
      }
    }

    // 🔥 删除 en.json 中已经移除的 key
    for (const key in flatLang) {
      if (!(key in flatEn)) {
        delete updatedLang[key];
        changes.removed.push(key);
      }
    }

    // console.log(updatedLang, "updatedLang");

    const nestedLang = unflattenJSON(updatedLang);

    // console.log(nestedLang["appScript"]);

    const prettyJson = JSON.stringify(nestedLang, null, 2);

    logChanges(lang, changes);

    // 记得将新的英语文件存储为 en_stable.json
    fs.writeFileSync(`./lang/${lang}.json`, prettyJson, "utf-8");

    const endTime = new Date();
    console.log(`🚀 同步完成 [${lang}]
      开始时间: ${startTime.toLocaleString()}
      结束时间: ${endTime.toLocaleString()}
      耗时: ${(endTime.getTime() - startTime.getTime()) / 1000}s
    `);

    // fs.writeFileSync(
    //   `./lang/test.json`,
    //   JSON.stringify(updatedLang, null, 2),
    //   "utf-8"
    // );

    // console.log(prettyJson, "prettyJson");
  }
}

run();
