import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import * as fs from "fs"; // 用于保存和加载任务进度
import * as path from "path"; // 导入 path 模块

// 设置你的代理地址，比如 Clash 的 HTTP 代理
const proxyAgent = new ProxyAgent("http://127.0.0.1:7890");

// 重写全局 fetch（Gemini SDK 用的是全局的 fetch）
globalThis.fetch = ((input: any, init?: any) => {
  return undiciFetch(input, { ...init, dispatcher: proxyAgent });
}) as any;

// API 密钥列表
const API_KEYS = [
  "AIzaSyALvVaZQwOsalOLdENzpk96ZSIUPECwhlg", // deng
  "AIzaSyAH7UIrEsCCwftjdTUpzo3By1ak8e_aA6Q", // wang
  "AIzaSyBlK2qtC6KUgwy5Pbv3NH3-NWQaezlDO3Y", // yang
];

const CACHE_DIR = "cache"; // 定义缓存目录的名称

const CACHE_FILE = path.join(CACHE_DIR, "translation_cache.json"); // 使用 path.join
const PROGRESS_FILE = path.join(CACHE_DIR, "translation_progress.json"); // 使用 path.join

class GeminiTranslator {
  private apiKeys: string[]; // API 密钥列表
  private currentKeyIndex: number; // 当前密钥索引
  private ai: GoogleGenAI; // AI 实例
  private cache: Map<string, string>; // 缓存
  private completedTranslations: Set<string>; // 存储已完成翻译的原始文本块
  private lastCallTime: number; // 上次调用时间

  constructor(apiKeys: string[]) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.ai = this.initializeGenAI(this.apiKeys[this.currentKeyIndex]);
    this.cache = new Map();
    this.completedTranslations = new Set();
    this.lastCallTime = 0;
    this.loadCache();
    this.loadProgress();
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
   * 获取缓存 key
   * @param chunkText
   * @param targetLang
   * @returns
   */
  private getCacheKey(chunkText: string, targetLang: string): string {
    return `${targetLang}::${chunkText}`;
  }

  /**
   * 节流函数，确保每次请求间隔 2000ms
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
   * 获取翻译系统指令
   */
  private getTranslateSystemInstruction(
    chunkText: string,
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
${chunkText}

Translated (${targetLang}):`;
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
   * 翻译单个文本，增加 API 密钥切换和重试机制
   */
  public async translateSingle(
    chunkText: string,
    targetLang: string
  ): Promise<string> {
    const cacheKey = this.getCacheKey(chunkText, targetLang);
    console.log(`\n🚀 开始翻译: ${chunkText}`);

    if (this.completedTranslations.has(cacheKey)) {
      console.log(`⏭️ 跳过已完成任务 (已记录): ${chunkText}`);
      return this.cache.get(cacheKey) || chunkText; // 返回缓存中的结果或原始文本
    }

    if (this.cache.has(cacheKey)) {
      console.log(`🔄 命中缓存: ${chunkText}`);
      this.completedTranslations.add(cacheKey); // 如果命中缓存，也标记为已完成
      this.saveProgress();
      return this.cache.get(cacheKey)!;
    }

    const maxApiRetries = this.apiKeys.length * 2; // 每个 API 密钥尝试两次
    let globalAttempt = 0;

    while (globalAttempt < maxApiRetries) {
      await this.throttle(); // 节流

      try {
        if (globalAttempt > 0) {
          console.log(
            `第 ${
              globalAttempt + 1
            } 次全局尝试翻译：${chunkText} (使用密钥索引: ${
              this.currentKeyIndex
            })`
          );
        }

        const response = await this.ai.models.generateContent({
          model: "gemini-2.0-flash-lite",
          contents: this.getTranslateSystemInstruction(chunkText, targetLang),
          config: {
            temperature: 0.7,
            topP: 1,
            topK: 1,
            maxOutputTokens: 4000,
            responseMimeType: "text/plain",
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

        const translatedText = response.text?.replace(/\n/g, "");

        // 检查 "I am sorry" 响应，将其视为错误
        if (translatedText?.includes("I am sorry")) {
          console.warn(`❌ Gemini 返回 "I am sorry"，视为翻译失败。`);
          throw new Error("Gemini returned 'I am sorry'.");
        }

        console.log("✅ response:", translatedText);

        this.cache.set(cacheKey, translatedText || "");
        this.saveCache();
        this.completedTranslations.add(cacheKey); // 标记为已完成
        this.saveProgress(); // 保存进度
        return translatedText || ""; // 成功返回翻译结果
      } catch (error: any) {
        console.error(
          `❌ 翻译失败 (密钥索引: ${this.currentKeyIndex}, 错误: ${
            error.message || error
          })`
        );

        // 如果是 429 或其他需要切换密钥的错误
        if (
          error.status === 429 ||
          error.message.includes("API key not valid") ||
          error.message.includes("Quota exceeded")
        ) {
          console.warn("❗ 检测到需要切换 API 密钥的错误。");
          this.switchToNextKey(); // 切换密钥
        } else {
          // 对于其他类型的错误，也可以选择切换密钥或者等待后重试
          // 这里我们选择等待后重试，但如果错误持续发生，最终会切换密钥
          console.log("❗ 非密钥错误，等待 2 秒后重试...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        globalAttempt++;
      }
    }

    console.error(
      `❌ 所有 API 密钥和重试尝试均失败，返回原始文本：${chunkText}`
    );
    this.cache.set(cacheKey, chunkText); // 失败时也缓存原始文本，避免重复尝试
    this.completedTranslations.add(chunkText); // 标记为已完成，避免死循环
    this.saveProgress();
    return chunkText; // 所有尝试失败时返回原始文本
  }

  /**
   * 主要的翻译入口函数
   * @param text 要翻译的文本块
   * @param targetLang 目标语言
   * @returns 翻译结果
   */
  public async translate(text: string, targetLang: string): Promise<string> {
    const result = await this.translateSingle(text, targetLang);
    return result;
  }
}

// 实例化翻译器
export const translator = new GeminiTranslator(API_KEYS);
