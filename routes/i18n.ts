import express from "express";
import path from "path";
import { ChildProcess, fork } from "child_process";
import { acquireLock, releaseLock } from "../util";
import { ossUtil, OSS_LANG_DIR } from "../util/oss";

const router = express.Router();

// 全局变量：存储当前正在运行的 syncI18n 子进程实例
let currentSyncProcess: ChildProcess | null = null;
let currentSyncProcessPromise: Promise<void> | null = null; // 用于等待旧进程终止

// 假设 runI18nSync.ts 是你的子进程脚本
const SYNC_SCRIPT_PATH = path.resolve(__dirname, "../util/runI18nSync.ts");

/**
 * 终止当前正在运行的 syncI18n 子进程
 * @returns {Promise<void>} 返回一个 Promise，在旧进程终止后 resolve
 */
async function terminateCurrentSyncProcess(): Promise<void> {
  // 捕获当前的进程实例到局部变量，避免被后续请求更改
  const processToTerminate = currentSyncProcess;
  const processPromiseToAwait = currentSyncProcessPromise; // 也捕获当前的 Promise

  if (processToTerminate && !processToTerminate.killed) {
    console.log(
      `检测到有正在运行的同步任务 (PID: ${processToTerminate.pid})，正在尝试终止...`
    );

    // 只有当没有等待中的 Promise 时才创建一个新的
    if (!processPromiseToAwait) {
      currentSyncProcessPromise = new Promise((resolve) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          console.log(
            `旧同步任务 (PID: ${processToTerminate?.pid}) 已终止。代码: ${code}, 信号: ${signal}`
          );
          // 确保只有在当前退出的是我们期望的进程时才清除全局引用
          if (currentSyncProcess === processToTerminate) {
            currentSyncProcess = null; // 清除引用
          }
          currentSyncProcessPromise = null; // 清除 Promise
          resolve();
        };

        processToTerminate.once("exit", onExit);
        processToTerminate.once("error", (err) => {
          console.error(
            `旧同步任务 (PID: ${processToTerminate?.pid}) 发生错误并终止: ${err.message}`
          );
          onExit(1, null); // 模拟退出
        });

        // 发送 SIGTERM 信号
        processToTerminate.kill("SIGTERM");

        // 为当前要终止的进程设置超时杀死
        setTimeout(() => {
          if (processToTerminate && !processToTerminate.killed) {
            console.warn(
              `旧同步任务 (PID: ${processToTerminate.pid}) 未响应 SIGTERM，发送 SIGKILL...`
            );
            processToTerminate.kill("SIGKILL");
          }
        }, 5000); // 5秒后如果还没退出，则强制杀死
      });
    }

    // 等待我们捕获的这个进程的 Promise 结束
    await (processPromiseToAwait || currentSyncProcessPromise);
  } else {
    console.log("没有正在运行的同步任务需要终止。");
    currentSyncProcess = null; // 确保引用是空的
    currentSyncProcessPromise = null;
  }
}

/**
 * 执行多语言同步
 * @param {string | null} uploadedEnJsonContent - 上传的 en.json 内容
 * @returns {Promise<{code: number, message: string, error?: string}>}
 */
async function executeI18nSync(
  uploadedEnJsonContent: string | null = null
): Promise<{
  code: number;
  message: string;
  error?: string;
}> {
  try {
    // 1. 尝试获取文件锁
    const lockAcquired = await acquireLock();
    if (!lockAcquired) {
      return {
        code: 429,
        message: "多语言同步任务正在进行中，请稍后再试（文件锁被占用）。",
      };
    }

    // 2. 如果获取到锁，终止所有旧任务
    await terminateCurrentSyncProcess();

    try {
      // 3. 启动新的同步任务
      console.log("启动新的多语言同步任务...");

      // 启动子进程，并将 uploadedEnJsonContent 作为参数传递
      // 子进程会处理接收到的内容，或自行从 OSS/本地获取
      const newSyncProcess = fork(
        SYNC_SCRIPT_PATH,
        uploadedEnJsonContent
          ? [
            "--en-json-content",
            Buffer.from(uploadedEnJsonContent).toString("base64"),
          ]
          : []
      );

      currentSyncProcess = newSyncProcess; // 保存新进程的引用
      currentSyncProcessPromise = null; // 清除旧 Promise，因为我们现在有一个新的进程

      newSyncProcess.on("exit", (code, signal) => {
        // 只有当退出的进程是当前活动的进程时，才清除全局引用并释放锁
        if (currentSyncProcess === newSyncProcess) {
          currentSyncProcess = null;
          releaseLock();
          console.log(
            `新的多语言同步子进程 (PID: ${newSyncProcess.pid}) 退出。代码: ${code}, 信号: ${signal}`
          );
        } else {
          console.log(
            `Non-current active process (PID: ${newSyncProcess.pid}) exited.`
          );
        }
      });

      newSyncProcess.on("error", (err) => {
        // 只有当错误的进程是当前活动的进程时，才清除全局引用并释放锁
        if (currentSyncProcess === newSyncProcess) {
          currentSyncProcess = null;
          releaseLock();
          console.error(
            `新的多语言同步子进程 (PID: ${newSyncProcess.pid}) encountered an error: ${err.message}`
          );
        } else {
          console.error(
            `Non-current active process (PID: ${newSyncProcess.pid}) encountered an error: ${err.message}`
          );
        }
      });

      return {
        code: 0,
        message: "旧任务已终止，新的多语言同步任务已提交至后台。",
      };
    } catch (e: any) {
      // 如果在新进程启动或绑定事件时发生错误，确保锁被释放
      releaseLock();
      currentSyncProcess = null; // 确保引用被清除
      currentSyncProcessPromise = null; // 确保 Promise 被清除
      return {
        code: 500,
        message: e?.message || "Failed to start sync process.",
        error: e?.message,
      };
    }
  } catch (e: any) {
    // 如果发生错误，确保锁被释放
    releaseLock();
    currentSyncProcess = null;
    currentSyncProcessPromise = null;
    return {
      code: 500,
      message: e?.message || "多语言同步任务提交失败",
      error: e?.message,
    };
  }
}

// 获取所有语言列表
router.get(
  "/get-langs",
  async (req: express.Request, res: express.Response) => {
    const { version } = req.query;
    try {
      const files = await ossUtil.listJsonFilesInDirectory(
        `${OSS_LANG_DIR}${version}/`
      );
      res.json({
        code: 0,
        data: {
          count: files.count,
          files: files.files,
        },
      });
    } catch (e: any) {
      res.status(500).json({
        code: 500,
        data: null,
        error: e?.message || "获取语言列表失败",
      });
    }
  }
);

// 获取指定语言的 JSON
router.get("/get-lang", async (req: any, res: any) => {
  const { lang, version } = req.query;
  try {
    const filePath = await ossUtil.getFileContent(
      `${OSS_LANG_DIR}${version}/${lang}.json`
    );
    if (!filePath) {
      return res.status(404).json({
        code: 404,
        data: null,
        error: "语言文件不存在",
      });
    }
    const data = JSON.parse(filePath);
    res.json({ code: 0, data });
  } catch (e: any) {
    res.status(500).json({
      code: 500,
      data: null,
      error: e?.message || "读取文件失败",
    });
  }
});

// 获取版本列表
router.get("/get-versions", async (req: any, res: any) => {
  try {
    const versions = await ossUtil.listLanguageVersions(OSS_LANG_DIR);
    res.json({ code: 0, data: versions });
  } catch (error: any) {
    res.status(500).json({
      code: 500,
      data: null,
      error: error?.message || "获取版本列表失败",
    });
  }
});

// 上传/更新指定语言的 JSON
router.post("/update-lang", async (req: any, res: any) => {
  let version = ""; // 版本号
  try {
    if (!req.files.version) {
      // 如果版本号为空，则获取最新版本
      const versions = await ossUtil.listLanguageVersions(OSS_LANG_DIR);
      if (versions.length > 0) {
        version = versions[versions.length - 1];
      }
    } else {
      version = req.files.version;
    }
  } catch (error: any) {
    return res.status(500).json({
      code: 500,
      data: null,
      error: error?.message || "获取版本号失败",
    });
  }

  // 检查是否有文件上传
  if (!req.files || !req.files.file) {
    return res.status(400).json({
      code: 400,
      data: null,
      error: "请上传 JSON 文件",
    });
  }

  const uploadedFile = req.files.file;

  // 检查文件类型
  if (
    !uploadedFile.mimetype.includes("application/json") &&
    !uploadedFile.name.endsWith(".json")
  ) {
    return res.status(400).json({
      code: 400,
      data: null,
      error: "请上传 JSON 格式的文件",
    });
  }

  // 从文件名提取语言代码
  const fileName = uploadedFile.name;
  const lang = fileName.replace(/\.json$/, "");

  if (!lang) {
    return res.status(400).json({
      code: 400,
      data: null,
      error: "文件名格式错误，应为 [语言代码].json",
    });
  }

  try {
    // 解析上传的 JSON 内容
    const jsonContent = JSON.parse(uploadedFile.data.toString());

    // 如果是 en，写入后自动触发多语言同步 --- 默认是最新版本
    if (lang === "en") {
      const jsonContent = uploadedFile.data.toString(); // 保持为字符串，传递给子进程

      const syncResult = await executeI18nSync(jsonContent);
      if (syncResult.code === 0) {
        return res.json({
          code: 0,
          data: null,
          message: `${lang}.json 更新成功，并已触发多语言同步任务。`,
        });
      } else {
        return res.status(syncResult.code).json({
          code: syncResult.code,
          data: null,
          error: syncResult.message,
        });
      }
    } else {
      // 写入文件 --- 非 en 语言
      await ossUtil.uploadFile(
        `${OSS_LANG_DIR}${version}/${lang}.json`,
        JSON.stringify(jsonContent, null, 2),
        {
          headers: {
            "Cache-Control": "no-cache",
          },
        }
      );
    }

    res.json({
      code: 0,
      data: null,
      message: `${lang}.json 更新成功`,
    });
  } catch (e: any) {
    releaseLock(); // 释放锁
    res.status(500).json({
      code: 500,
      data: null,
      error: e?.message || "文件处理失败",
    });
  }
});

// 新增：手动触发多语言同步 (同样通过子进程)
// router.post("/sync", async (req: any, res: any) => {
//   const syncResult = await executeI18nSync();
//   if (syncResult.code === 0) {
//     res.json({
//       code: 0,
//       data: null,
//       message: syncResult.message,
//     });
//   } else {
//     res.status(syncResult.code).json({
//       code: syncResult.code,
//       data: null,
//       error: syncResult.message,
//     });
//   }
// });

export default router;
