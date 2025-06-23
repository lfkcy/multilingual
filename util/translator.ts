import pLimit from "p-limit";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import { fetch as undiciFetch, ProxyAgent } from "undici";

// 设置你的代理地址，比如 Clash 的 HTTP 代理
const proxyAgent = new ProxyAgent("http://127.0.0.1:7890");

// 重写全局 fetch（Gemini SDK 用的是全局的 fetch）
globalThis.fetch = ((input: any, init?: any) => {
  return undiciFetch(input, { ...init, dispatcher: proxyAgent });
}) as any;

// const limit = pLimit(5);
const ai = new GoogleGenAI({
  apiKey: "AIzaSyALvVaZQwOsalOLdENzpk96ZSIUPECwhlg",
});

/**
 * deng: AIzaSyALvVaZQwOsalOLdENzpk96ZSIUPECwhlg
 * wang: AIzaSyAH7UIrEsCCwftjdTUpzo3By1ak8e_aA6Q
 * yang: AIzaSyBlK2qtC6KUgwy5Pbv3NH3-NWQaezlDO3Y
 */

const cache = new Map(); // 缓存翻译结果

/**
 * 获取缓存 key
 * @param chunkText
 * @param targetLang
 * @returns
 */
const getCacheKey = (chunkText: string, targetLang: string) =>
  `${targetLang}::${chunkText}`;

// ✅ 每次请求间隔 2000ms（即 30 次/分钟）
let lastCallTime = 0;
const throttle = async () => {
  const now = Date.now();
  const waitTime = Math.max(0, 2000 - (now - lastCallTime));
  if (waitTime > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastCallTime = Date.now();
};

/**
 * 获取翻译系统指令
 */
const getTranslateSystemInstruction = (
  chunkText: string,
  targetLang: string
) => {
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
};

/**
 * 翻译单个文本，增加 429 重试机制（最多 5 次，每次间隔 2s）
 */
const translateSingle = async (
  chunkText: string,
  targetLang: string
): Promise<string> => {
  console.log(`\n🚀 开始翻译: ${chunkText}`);

  if (cache.has(getCacheKey(chunkText, targetLang))) {
    console.log(`🔄 命中缓存: ${chunkText}`);
    return cache.get(getCacheKey(chunkText, targetLang));
  }

  const maxRetries = 5;
  let attempt = 0;

  while (attempt < maxRetries) {
    await throttle(); // 节流 --- 防止请求过于频繁

    try {
      if (attempt > 0) {
        console.log(`\n🚀 第 ${attempt + 1} 次尝试翻译：${chunkText}`);
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash-lite",
        contents: getTranslateSystemInstruction(chunkText, targetLang),
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

      // TODO: 包含 I am sorry 的翻译结果，需要重新翻译
      if (response.text?.includes("I am sorry")) {
        throw new Error("I am sorry");
      }

      console.log("✅ response:", response.text?.replace(/\n/g, ""));

      cache.set(
        getCacheKey(chunkText, targetLang),
        response.text?.replace(/\n/g, "")
      );
      return response.text?.replace(/\n/g, "") || ""; // 成功返回翻译结果
    } catch (error: any) {
      console.log("❌ error:", error);

      attempt++;

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.error(`❌ 所有重试失败，返回原始文本：${chunkText}`);
  cache.set(getCacheKey(chunkText, targetLang), chunkText);
  return chunkText; // 失败时返回原始文本
};

export async function translate(
  text: string,
  targetLang: string
): Promise<string> {
  const result = await translateSingle(text, targetLang);
  return result;
}
