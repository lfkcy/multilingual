import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import * as fs from "fs";
import * as path from "path";

const isProduction = process.env.NODE_ENV === "production";

// 如果非生产环境，则设置代理 --- 生产环境需部署在海外服务器
if (!isProduction) {
  // 设置你的代理地址，比如 Clash 的 HTTP 代理
  const proxyAgent = new ProxyAgent(
    process.env.HTTP_PROXY || "http://127.0.0.1:7890"
  );

  // 重写全局 fetch（Gemini SDK 内部使用全局的 fetch）
  globalThis.fetch = ((input: any, init?: any) => {
    return undiciFetch(input, { ...init, dispatcher: proxyAgent });
  }) as any;
}

// API 密钥列表
const API_KEYS = process.env.GEMINI_API_KEYS!.split(",") || [];

// 缓存目录和文件路径
const CACHE_DIR = "cache";
const CACHE_FILE = path.join(CACHE_DIR, "translation_cache.json");
const PROGRESS_FILE = path.join(CACHE_DIR, "translation_progress.json");

/**
 * 辅助函数：判断一个字符串是否可能是标识符或代码（不应翻译）
 * 这是一个启发式判断，可能不完全准确，但能过滤掉大部分不应翻译的字符串。
 * 模型提示词中应更严格地定义这些规则。
 * @param text 待判断字符串
 * @returns 如果可能是标识符或代码则返回 true
 */
function isLikelyIdentifierOrCode(text: string): boolean {
  // 规则可以根据你的实际数据进行调整和细化
  // 1. 包含下划线或连字符，且不包含空格，通常是文件名、ID等
  if ((text.includes("_") || text.includes("-")) && !text.includes(" "))
    return true;
  // 2. 纯数字字符串
  if (/^\d+$/.test(text)) return true;
  // 3. 包含大量特殊字符（非字母、数字、常见标点），可能是路径、URL等
  if (/[^a-zA-Z0-9\s.,?!-]/.test(text)) return true;
  // 4. 以特定前缀开头（如图片路径、按钮类型）
  if (
    text.startsWith("img_") ||
    text.startsWith("btn_") ||
    text.startsWith("ID_")
  )
    return true;
  // 5. 纯小写或纯大写且较短的单词，可能是枚举值
  if (
    text.length < 15 &&
    (text === text.toLowerCase() || text === text.toUpperCase()) &&
    !text.includes(" ")
  )
    return true;

  // 如果值本身是 JSON 字符串，那更不应该翻译
  try {
    JSON.parse(text);
    return true;
  } catch (e) {
    // 不是有效的JSON
  }

  return false;
}

/**
 * Gemini 翻译器类，用于处理 JSON 结构的多语言翻译
 */
class GeminiTranslator {
  private apiKeys: string[];
  private currentKeyIndex: number;
  private ai: GoogleGenAI;
  private cache: Map<string, string>;
  private completedTranslations: Set<string>;
  private lastCallTime: number;

  constructor(apiKeys: string[]) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.ai = this.initializeGenAI(this.apiKeys[this.currentKeyIndex]);
    this.cache = new Map();
    this.completedTranslations = new Set();
    this.lastCallTime = 0;
    this.loadCache();
    this.loadProgress();

    // 创建缓存目录
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR);
    }
  }

  /**
   * 初始化 GoogleGenAI 实例
   * @param apiKey
   * @returns
   */
  private initializeGenAI(apiKey: string): GoogleGenAI {
    console.log(`\n🔑 正在使用 API 密钥: ${apiKey.substring(0, 5)}...`);
    return new GoogleGenAI({ apiKey });
  }

  /**
   * 切换到下一个 API 密钥
   */
  private switchToNextKey(): void {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.ai = this.initializeGenAI(this.apiKeys[this.currentKeyIndex]);
    console.warn(
      `⚠️ 切换到下一个 API 密钥。当前密钥索引: ${this.currentKeyIndex}`
    );
  }

  /**
   * 获取缓存键
   * @param chunkText
   * @param targetLang
   * @returns
   */
  private getCacheKey(chunkText: string, targetLang: string): string {
    return `${targetLang}::${chunkText}`;
  }

  /**
   * 节流
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitTime = Math.max(0, 2000 - (now - this.lastCallTime));
    if (waitTime > 0) {
      console.log(`⏳ 节流中，等待 ${waitTime}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastCallTime = Date.now();
  }

  /**
   * 获取翻译系统指令 - 专门用于 JSON 结构翻译。
   */
  private getTranslateSystemInstruction(
    jsonChunk: string,
    targetLang: string
  ): string {
    return `You are a highly accurate and strict JSON translator. Your sole task is to translate ONLY the natural language string values within the provided JSON object from English to ${targetLang}.

**CRITICAL INSTRUCTIONS:**

1.  **TRANSLATE ONLY TEXT VALUES:** Translate only string values that are human-readable text meant for users (e.g., labels, messages, button text).
2.  **PRESERVE NON-TEXT VALUES AND KEYS:** DO NOT translate any of the following:
    * **JSON Keys** (left side of key-value pairs).
    * **Identifiers/Codes:** Short strings mixing letters/numbers (e.g., "image1", "btn_ok", "title123", "v2_setting", "pending", "success", "user_id").
    * **System Values:** Strings resembling enum values, system identifiers, or statuses.
    * **Numbers, Booleans (true, false), or Null.**
    * **Any string that is a valid JSON object or array itself.**
    * **DO NOT modify the JSON structure:** Brackets {}, colons :, commas , must remain exactly as they are.
3.  **PLACEHOLDER HANDLING:** For strings containing placeholders (e.g., <guidelines>value</guidelines>, {{variable}}, %s, $count):
    * **KEEP PLACEHOLDERS INTACT.**
    * Translate the surrounding text if appropriate.
    * If unsure, leave the entire string untranslated.
4.  **OUTPUT ONLY JSON:** Your response MUST be a valid JSON object. Do not include any introductory text, comments, formatting, or explanation outside the JSON.

Input JSON (English):
\`\`\`json
${jsonChunk}
\`\`\`

Translated JSON (${targetLang}):`;
  }

  /**
   * 获取翻译单个字符串的系统指令。
   * @param text 要翻译的文本
   * @param targetLang 目标语言
   * @returns 系统指令字符串
   */
  private getTranslateTextInstruction(
    text: string,
    targetLang: string
  ): string {
    return `You are an expert JSON translator. Your task is to translate only the natural language string values in the JSON from English to ${targetLang}.

**Strict Instructions:**

1. Translate ONLY the string values that are human-readable text intended for end users (e.g., labels, messages, button text).

2. DO NOT translate:

- Keys (the left side of key-value pairs).
- Short identifier-like strings that mix letters and numbers (e.g., "image1", "btn_ok", "title123").
- Strings that resemble keys, codes, enum values, or system identifiers.
- Numbers, booleans (true, false), or null.

3. For strings with placeholders (e.g., <guidelines>value</guidelines>, {{variable}}, %s, $count):

- Keep the placeholder intact.
- Translate the surrounding text if appropriate.
- If unsure how to handle it, leave the string untranslated.

4. If the input is a single standalone string (e.g., "Start your journey"), return only the translated string without quotes, formatting, or comments.

Examples of strings you should NOT translate:

"imageKey": "image1"

"status": "pending"

"buttonType": "btn_primary"

"config": "v2_setting"

"avatar": "comment1"

Input:
${text}

Translated (${targetLang}):`;
  }

  /**
   * 翻译单个纯文本字符串（非 JSON 结构）。
   * @param text 要翻译的字符串
   * @param targetLang 目标语言
   * @returns 翻译后的字符串
   */
  private async translateSingleString(
    text: string,
    targetLang: string
  ): Promise<string> {
    if (typeof text !== "string" || text.trim() === "") {
      return text; // 不是字符串或空字符串，直接返回
    }
    // 在单行翻译前也进行标识符判断，避免不必要的API调用
    if (isLikelyIdentifierOrCode(text)) {
      console.log(
        `   ⏭️ 跳过单行翻译 (可能是标识符): ${text.substring(0, 30)}...`
      );
      return text;
    }

    const cacheKey = this.getCacheKey(`_STRING_:${text}`, targetLang); // 单独的缓存键前缀
    if (this.cache.has(cacheKey)) {
      console.log(`   🔀 命中单行缓存: ${text.substring(0, 30)}...`);
      return this.cache.get(cacheKey)!;
    }

    console.log(`   ✨ 尝试单行翻译: ${text.substring(0, 50)}...`);
    const maxAttempts = 3; // 单行翻译的重试次数
    let attempt = 0;

    while (attempt < maxAttempts) {
      await this.throttle(); // 依然遵守节流

      try {
        const result = await this.ai.models.generateContent({
          model: "gemini-2.0-flash-lite",
          contents: [
            {
              role: "user",
              parts: [
                { text: this.getTranslateTextInstruction(text, targetLang) },
              ],
            },
          ],
          config: {
            temperature: 0.1, // 更低的温度以获得更直接的翻译
            maxOutputTokens: 1000, // 足够长的单行文本
            safetySettings: [
              {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
            ],
          },
        });
        if (!result.text) {
          throw new Error("单行翻译返回空文本");
        }
        const translatedText = result.text.trim();
        // 简单的校验，避免模型返回空或非预期内容
        if (!translatedText || translatedText.length < 1) {
          // 长度小于1，视为无效翻译
          throw new Error("单行翻译返回空文本");
        }
        this.cache.set(cacheKey, translatedText);
        this.saveCache();
        return translatedText;
      } catch (error: any) {
        console.error(
          `   ❌ 单行翻译失败 (尝试 ${attempt + 1}/${maxAttempts}, 错误: ${
            error.message || error
          })`
        );
        if (
          error.status === 429 ||
          error.message.includes("API key not valid") ||
          error.message.includes("Quota exceeded") ||
          error.message.includes("RESOURCE_EXHAUSTED")
        ) {
          console.warn("   ❗ 检测到配额/密钥错误，切换密钥。");
          this.switchToNextKey();
        } else {
          console.log(`   ❗ 等待 ${2000 / 1000} 秒后重试...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        attempt++;
      }
    }
    console.warn(
      `   ⚠️ 单行翻译最终失败，返回原始文本: ${text.substring(0, 50)}...`
    );
    return text; // 失败后返回原始文本
  }

  /**
   * 递归遍历 JSON 对象，查找未翻译的字符串并调用单行翻译函数进行翻译。
   * 这个函数会对比原始值和翻译后的值，如果相同且是可翻译字符串，则进行二次翻译。
   * @param originalJsonObj 原始的 JSON 对象或数组
   * @param currentTranslatedObj 当前已翻译的 JSON 对象或数组
   * @param targetLang 目标语言
   * @returns 修复（二次翻译）后的 JSON 对象或数组
   */
  private async findAndTranslateRemainingStrings(
    originalJsonObj: any,
    currentTranslatedObj: any,
    targetLang: string
  ): Promise<any> {
    if (
      typeof originalJsonObj !== "object" ||
      originalJsonObj === null ||
      typeof currentTranslatedObj !== "object" ||
      currentTranslatedObj === null
    ) {
      return currentTranslatedObj; // 非对象或数组直接返回当前翻译结果
    }

    if (Array.isArray(originalJsonObj) && Array.isArray(currentTranslatedObj)) {
      // 如果是数组，遍历每个元素
      for (
        let i = 0;
        i < originalJsonObj.length && i < currentTranslatedObj.length;
        i++
      ) {
        currentTranslatedObj[i] = await this.findAndTranslateRemainingStrings(
          originalJsonObj[i],
          currentTranslatedObj[i],
          targetLang
        );
      }
    } else if (
      !Array.isArray(originalJsonObj) &&
      !Array.isArray(currentTranslatedObj)
    ) {
      // 如果是对象，遍历每个键值对
      for (const key in originalJsonObj) {
        if (Object.prototype.hasOwnProperty.call(originalJsonObj, key)) {
          const originalValue = originalJsonObj[key];
          const translatedValue = currentTranslatedObj[key];

          if (
            typeof originalValue === "string" &&
            typeof translatedValue === "string"
          ) {
            // 如果原始值和翻译值都是字符串
            // 且原始值和翻译值相同 (表示可能未翻译)
            // 且原始值不是我们判断为标识符或代码的类型
            if (
              originalValue === translatedValue &&
              !isLikelyIdentifierOrCode(originalValue)
            ) {
              console.log(
                `   🔍 发现未翻译字符串 (原始==翻译): ${originalValue.substring(
                  0,
                  50
                )}...`
              );
              currentTranslatedObj[key] = await this.translateSingleString(
                originalValue,
                targetLang
              );
            }
          } else if (
            typeof originalValue === "object" &&
            originalValue !== null
          ) {
            // 如果是嵌套对象或数组，递归调用
            currentTranslatedObj[key] =
              await this.findAndTranslateRemainingStrings(
                originalValue,
                translatedValue,
                targetLang
              );
          }
        }
      }
    }
    return currentTranslatedObj;
  }

  /**
   * 加载缓存
   */
  private loadCache(): void {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data = fs.readFileSync(CACHE_FILE, "utf8");
        const parsedCache = JSON.parse(data);
        this.cache = new Map(parsedCache);
        console.log(`✅ 已从 ${CACHE_FILE} 加载 ${this.cache.size} 条缓存。`);
      }
    } catch (error) {
      console.error(`❌ 加载缓存失败: ${error}`);
    }
  }

  /**
   * 保存缓存
   */
  private saveCache(): void {
    try {
      const cacheArray = Array.from(this.cache.entries());
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheArray, null, 2), "utf8");
      console.log(`💾 已保存 ${this.cache.size} 条缓存到 ${CACHE_FILE}。`);
    } catch (error) {
      console.error(`❌ 保存缓存失败: ${error}`);
    }
  }

  /**
   * 加载翻译进度
   */
  private loadProgress(): void {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        const data = fs.readFileSync(PROGRESS_FILE, "utf8");
        const parsedProgress = JSON.parse(data);
        this.completedTranslations = new Set(
          parsedProgress.completedTranslations
        );
        this.currentKeyIndex = parsedProgress.currentKeyIndex || 0; // 加载上次使用的密钥索引
        this.ai = this.initializeGenAI(this.apiKeys[this.currentKeyIndex]); // 重新初始化 AI 实例
        console.log(
          `✅ 已从 ${PROGRESS_FILE} 加载 ${this.completedTranslations.size} 条已完成任务和上次密钥索引 ${this.currentKeyIndex}。`
        );
      }
    } catch (error) {
      console.error(`❌ 加载翻译进度失败: ${error}`);
    }
  }

  /**
   * 保存翻译进度
   */
  private saveProgress(): void {
    try {
      const progressData = {
        completedTranslations: Array.from(this.completedTranslations),
        currentKeyIndex: this.currentKeyIndex,
      };
      fs.writeFileSync(
        PROGRESS_FILE,
        JSON.stringify(progressData, null, 2),
        "utf8"
      );
      console.log(`💾 已保存翻译进度到 ${PROGRESS_FILE}。`);
    } catch (error) {
      console.error(`❌ 保存翻译进度失败: ${error}`);
    }
  }

  /**
   * 翻译单个 JSON 文本块。
   * 这个方法包含重试机制、节流和错误处理，并新增了二次（单行）翻译逻辑，以最大限度提高成功率。
   * @param jsonChunk 要翻译的 JSON 文本片段
   * @param targetLang 目标语言
   * @returns 翻译后的 JSON 文本片段，如果失败则返回原始片段
   */
  public async translateSingleJsonChunk(
    jsonChunk: string,
    targetLang: string
  ): Promise<string> {
    const cacheKey = this.getCacheKey(jsonChunk, targetLang);
    console.log(`\n🚀 开始翻译 JSON 片段: ${jsonChunk.substring(0, 50)}...`);

    if (this.completedTranslations.has(cacheKey)) {
      console.log(
        `⏭️ 跳过已完成任务 (已记录): ${jsonChunk.substring(0, 50)}...`
      );
      return this.cache.get(cacheKey) || jsonChunk;
    }

    if (this.cache.has(cacheKey)) {
      console.log(`🔄 命中缓存: ${jsonChunk.substring(0, 50)}...`);
      this.completedTranslations.add(cacheKey);
      this.saveProgress();
      return this.cache.get(cacheKey)!;
    }

    const maxApiRetries = this.apiKeys.length * 2; // 每个 API 密钥尝试两次
    let globalAttempt = 0;

    // 尝试解析原始 JSON，以便后续对比
    let originalParsedJson: any;
    try {
      originalParsedJson = JSON.parse(jsonChunk);
    } catch (e) {
      console.error(`❌ 无法解析原始 JSON 片段，可能不是有效的 JSON: ${e}`);
      // 如果原始 JSON 本身就无效，我们无法进行深度比较，直接返回原始 chunk
      this.cache.set(cacheKey, jsonChunk);
      this.completedTranslations.add(cacheKey);
      this.saveProgress();
      return jsonChunk;
    }

    let currentTranslatedObj: any = originalParsedJson; // 初始化为原始解析对象，准备进行翻译

    while (globalAttempt < maxApiRetries) {
      await this.throttle();

      try {
        if (globalAttempt > 0) {
          console.log(
            `第 ${
              globalAttempt + 1
            }/${maxApiRetries} 次全局尝试翻译 JSON 片段：${jsonChunk.substring(
              0,
              50
            )}... (使用密钥索引: ${this.currentKeyIndex})`
          );
        }

        const result = await this.ai.models.generateContent({
          model: "gemini-2.0-flash-lite",
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: this.getTranslateSystemInstruction(
                    jsonChunk,
                    targetLang
                  ),
                },
              ],
            },
          ],
          config: {
            temperature: 0.1,
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
            safetySettings: [
              {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
            ],
          },
        });

        const responseText = result.text;

        if (!responseText || responseText.trim() === "") {
          throw new Error("Gemini 返回了空响应或只有空白字符的响应。");
        }

        console.log("Gemini 原始响应 (部分):", responseText.substring(0, 200));

        try {
          // 尝试解析 Gemini 返回的 JSON
          currentTranslatedObj = JSON.parse(responseText);
          console.log("✅ 首次 JSON 解析成功。");
        } catch (jsonParseError) {
          console.warn(
            `⚠️ 首次无法解析 Gemini 返回的 JSON。原始响应: "${responseText.substring(
              0,
              200
            )}..." 错误: ${jsonParseError}`
          );
          // 如果首次解析失败，就保持 currentTranslatedObj 为原始解析对象，让后续的单行修复进行处理
          currentTranslatedObj = originalParsedJson;
        }

        // 无论首次翻译是否成功解析，都进行二次检查和修复
        console.log("进行二次检查并尝试修复未翻译字符串...");
        currentTranslatedObj = await this.findAndTranslateRemainingStrings(
          originalParsedJson,
          currentTranslatedObj,
          targetLang
        );
        console.log("✨ 二次检查及修复完成。");

        const finalTranslatedJson = JSON.stringify(
          currentTranslatedObj,
          null,
          2
        );

        console.log(
          "✅ 翻译响应 (部分):",
          finalTranslatedJson.substring(0, 200)
        );

        this.cache.set(cacheKey, finalTranslatedJson);
        this.saveCache();
        this.completedTranslations.add(cacheKey);
        this.saveProgress();
        return finalTranslatedJson; // 翻译成功！
      } catch (error: any) {
        console.error(
          `❌ 翻译失败 (密钥索引: ${this.currentKeyIndex}, 错误: ${
            error.message || error
          })`
        );

        if (
          error.status === 429 ||
          error.message.includes("API key not valid") ||
          error.message.includes("Quota exceeded") ||
          error.message.includes("RESOURCE_EXHAUSTED")
        ) {
          console.warn("❗ 检测到 API 密钥或配额错误。正在切换密钥。");
          this.switchToNextKey();
        } else {
          console.log(`❗ 非密钥错误，将在 ${2000 / 1000} 秒后重试...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        globalAttempt++;
      }
    }

    console.error(
      `❌ 所有 API 密钥和重试尝试均失败。返回原始 JSON 片段：${jsonChunk.substring(
        0,
        50
      )}...`
    );
    this.cache.set(cacheKey, jsonChunk);
    this.completedTranslations.add(cacheKey);
    this.saveProgress();
    return jsonChunk;
  }
}

export const translator = new GeminiTranslator(API_KEYS);
