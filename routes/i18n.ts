import express from "express";
import {
  acquireLock,
  releaseLock,
  isLockActive,
  startLockHeartbeat,
  getProjectSyncStatus,
} from "../util";
import { getOssUtil, OSS_LANG_DIR } from "../util/oss";
import { apiKeyAuth } from "../util/middleware";
import {
  getLangVersionByCommitId,
  recordPromoteRequest,
  addTranslationTask,
  getPendingTaskCount,
  getNextTranslationTask,
  updateTranslationTaskStatus,
  removeTranslationTask,
} from "../util/versioning";
import { runI18nSync } from "../util/runI18nSync";

const router = express.Router();

/**
 * 执行多语言同步
 * @param {string | null} uploadedEnJsonContent - 上传的 en.json 内容
 * @param {string | null} projectId - 项目 ID
 * @param {boolean} promoteToCurrent - 是否在同步成功后自动复制到 current 目录
 * @param {string | null} commitId - 提交 ID
 * @returns {Promise<{code: number, message: string, error?: string}>}
 */
async function executeI18nSync(
  uploadedEnJsonContent: string | null = null,
  projectId: string | null = null,
  promoteToCurrent: boolean = false, // 默认为 false
  commitId: string | null = null // 默认为 null
): Promise<{
  code: number;
  message: string;
  error?: string;
}> {
  try {
    // 1. 尝试获取文件锁
    const lockAcquired = await acquireLock(projectId || "unknown");
    if (!lockAcquired) {
      // 如果无法获取锁，将任务添加到队列中
      console.log(`[${projectId}] 翻译服务忙碌，将任务添加到队列中...`);

      const taskId = await addTranslationTask({
        projectId: projectId || "unknown",
        uploadedEnJsonContent,
        promoteToCurrent,
        commitId,
      });

      const pendingCount = await getPendingTaskCount(projectId || undefined);

      return {
        code: 0,
        message: `翻译服务忙碌, 任务已加入队列。任务ID: ${taskId}，当前项目队列位置: ${pendingCount}`,
      };
    }

    // 2. 直接在当前进程异步执行同步逻辑，并开启锁心跳
    console.log(`[${projectId}] 启动新的多语言同步任务...`);
    const stopHeartbeat = startLockHeartbeat();
    (async () => {
      try {
        await runI18nSync({
          projectId,
          uploadedEnJsonContent,
          promoteToCurrent,
          commitId,
        });
        console.log(`[${projectId}] 多语言同步任务完成。`);
      } catch (e: any) {
        console.error(`[${projectId}] 多语言同步任务失败:`, e?.message || e);
      } finally {
        stopHeartbeat();
        releaseLock();
        // 释放锁后，处理队列中的下一个任务
        await processNextQueuedTask();
      }
    })();

    return {
      code: 0,
      message: "新的多语言同步任务已提交至后台",
    };
  } catch (e: any) {
    // 如果发生错误，确保锁被释放
    releaseLock();
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
  apiKeyAuth,
  async (req: express.Request, res: express.Response) => {
    const { version } = req.query;
    const projectId = (req as any).projectId;

    try {
      const ossUtil = getOssUtil(projectId);

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
router.get("/get-lang", apiKeyAuth, async (req: any, res: any) => {
  const { lang, version } = req.query;
  const projectId = (req as any).projectId;
  const ossUtil = getOssUtil(projectId);

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
router.get("/get-versions", apiKeyAuth, async (req: any, res: any) => {
  try {
    const projectId = (req as any).projectId;
    const ossUtil = getOssUtil(projectId);

    const versions = await ossUtil.listLanguageVersions(OSS_LANG_DIR);

    // 获取项目级别的翻译状态
    const projectStatus = await getProjectSyncStatus(projectId);

    res.json({
      code: 0,
      data: versions,
      isAsyncing: projectStatus.isAsyncing,
    });
  } catch (error: any) {
    res.status(500).json({
      code: 500,
      data: null,
      error: error?.message || "获取版本列表失败",
    });
  }
});

// 获取是否正在同步状态
router.get("/get-is-asyncing", apiKeyAuth, async (req: any, res: any) => {
  try {
    const projectId = (req as any).projectId;
    const { projectId: queryProjectId } = req.query;

    // 优先使用查询参数中的projectId，否则使用认证中的projectId
    const targetProjectId = queryProjectId || projectId;

    if (targetProjectId) {
      // 获取特定项目的翻译状态
      const projectStatus = await getProjectSyncStatus(targetProjectId);
      console.log(
        `[get-is-asyncing] 项目 ${targetProjectId} 翻译状态:`,
        projectStatus
      );
      res.json({
        code: 0,
        data: {
          isAsyncing: projectStatus.isAsyncing,
          status: projectStatus.status,
          taskId: projectStatus.taskId,
          timestamp: projectStatus.timestamp,
        },
      });
    } else {
      // 向后兼容：返回全局锁状态
      const isAsyncing = isLockActive();
      console.log(`[get-is-asyncing] 全局翻译状态: ${isAsyncing}`);
      res.json({ code: 0, data: { isAsyncing } });
    }
  } catch (e: any) {
    res.status(500).json({
      code: 500,
      data: null,
      error: e?.message || "获取是否正在同步状态失败",
    });
  }
});

// 上传/更新指定语言的 JSON
router.post("/update-lang", apiKeyAuth, async (req: any, res: any) => {
  let version = ""; // 版本号
  const projectId = (req as any).projectId;

  // 获取 promoteToCurrent 参数，用于控制是否自动复制到 current 目录
  let promoteToCurrent = false;
  if (req.body && req.body.promoteToCurrent) {
    promoteToCurrent = req.body.promoteToCurrent === "true";
  }

  let commitId: string | null = null;
  if (req.body && req.body.commitId) {
    commitId = req.body.commitId;
  }
  const ossUtil = getOssUtil(projectId);

  try {
    if (!req.files.version) {
      // 如果版本号为空，则获取最新版本
      version = (await ossUtil.findLatestVersion()) ?? "";
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
    const ossUtil = getOssUtil(projectId);

    // 如果是 en，写入后自动触发多语言同步 --- 默认是最新版本
    if (lang === "en") {
      const jsonContent = uploadedFile.data.toString(); // 保持为字符串，传递给子进程

      const syncResult = await executeI18nSync(
        jsonContent,
        projectId,
        promoteToCurrent,
        commitId
      );
      if (syncResult.code === 0) {
        return res.json({
          code: 0,
          data: null,
          message:
            syncResult.message ||
            `${lang}.json 更新成功，并已触发多语言同步任务。`,
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

/**
 * promote-version
 * 用于前端部署完成后，将指定 Commit ID 对应的版本推广到 current 目录。
 * 如果翻译未完成，会记录推广请求，等待翻译完成后自动执行。
 */
router.post("/promote-version", apiKeyAuth, async (req: any, res: any) => {
  console.log("promote-version 请求开始");

  let commitId = "";
  if (req.body && req.body.commitId) {
    commitId = req.body.commitId;
  }
  const projectId = (req as any).projectId;

  let langVersionToPromote: string | null = null;

  try {
    const ossUtil = getOssUtil(projectId);

    // 1. 根据 Commit ID 查找版本号
    if (commitId) {
      langVersionToPromote = await getLangVersionByCommitId(commitId);

      if (!langVersionToPromote) {
        // 如果找不到版本号，记录推广请求，等待翻译完成
        console.log(
          `Commit ID ${commitId} 未找到对应的语言版本号，记录推广请求`
        );
        await recordPromoteRequest(commitId, projectId);

        return res.json({
          code: 0,
          data: {
            commitId: commitId,
            version: null,
            target: "current",
            status: "pending",
          },
          message: `Commit ID ${commitId} 对应的翻译尚未完成，已记录推广请求，翻译完成后将自动推广到 current 目录。`,
        });
      }
    } else {
      // 2. 如果 Commit ID 未传入，则自动选择 OSS 中最新版本
      langVersionToPromote = await ossUtil.findLatestVersion();
      console.log("langVersionToPromote", langVersionToPromote);

      if (!langVersionToPromote) {
        return res.status(404).json({
          code: 404,
          data: null,
          error: "OSS 中没有找到任何语言版本，无法推广。",
        });
      }
      console.log(
        `未指定 Commit ID, 则自动选择 OSS 中最新版本: ${langVersionToPromote}`
      );
    }

    // 3. 检查语言版本目录是否存在
    const versions = await ossUtil.listLanguageVersions(OSS_LANG_DIR);
    if (!versions.includes(langVersionToPromote)) {
      // 如果版本目录不存在，记录推广请求
      if (commitId) {
        console.log(`语言版本号 ${langVersionToPromote} 不存在，记录推广请求`);
        await recordPromoteRequest(commitId, projectId);

        return res.json({
          code: 0,
          data: {
            commitId: commitId,
            version: langVersionToPromote,
            target: "current",
            status: "pending",
          },
          message: `版本 ${langVersionToPromote} 尚未同步完成，已记录推广请求，翻译完成后将自动推广到 current 目录。`,
        });
      } else {
        return res.status(404).json({
          code: 404,
          data: null,
          error: `语言版本号 ${langVersionToPromote} 不存在或尚未同步完成`,
        });
      }
    }

    // 4. 执行复制操作
    await ossUtil.copyVersionToCurrent(langVersionToPromote);

    // 5. 返回成功
    res.json({
      code: 0,
      data: {
        commitId: commitId,
        version: langVersionToPromote,
        target: "current",
        status: "completed",
      },
      message: `版本 ${langVersionToPromote} 已成功推广到 current 目录。`,
    });
  } catch (e: any) {
    res
      .status(500)
      .json({ code: 500, data: null, error: e?.message || "推广版本失败" });
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

/**
 * 处理队列中的下一个翻译任务
 */
async function processNextQueuedTask(): Promise<void> {
  try {
    const nextTask = await getNextTranslationTask();

    if (!nextTask) {
      console.log("[QUEUE] 队列中没有待处理的任务");
      return;
    }

    console.log(
      `[QUEUE] 开始处理队列中的任务: ${nextTask.id} (项目: ${nextTask.projectId})`
    );

    // 尝试获取锁
    const lockAcquired = await acquireLock(nextTask.projectId, nextTask.id);
    if (!lockAcquired) {
      console.log(`[QUEUE] 无法获取锁，任务 ${nextTask.id} 将等待下次处理`);
      // 将任务状态重置为 pending
      await updateTranslationTaskStatus(nextTask.id, "pending");
      return;
    }

    // 开启锁心跳
    const stopHeartbeat = startLockHeartbeat();

    console.log(
      `projectId: ${nextTask.projectId},commitId:${nextTask.commitId} 开启翻译`
    );

    try {
      await runI18nSync({
        projectId: nextTask.projectId,
        uploadedEnJsonContent: nextTask.uploadedEnJsonContent,
        promoteToCurrent: nextTask.promoteToCurrent,
        commitId: nextTask.commitId,
      });

      console.log(`[QUEUE] 任务 ${nextTask.id} 处理完成`);
      await updateTranslationTaskStatus(nextTask.id, "completed");
      await removeTranslationTask(nextTask.id);
    } catch (error: any) {
      console.error(
        `[QUEUE] 任务 ${nextTask.id} 处理失败:`,
        error?.message || error
      );
      await updateTranslationTaskStatus(nextTask.id, "failed");
      // 失败的任务不移除，可以稍后重试
    } finally {
      stopHeartbeat();
      releaseLock();

      // 递归处理下一个任务
      setTimeout(() => {
        processNextQueuedTask().catch((err) => {
          console.error("[QUEUE] 处理下一个任务时发生错误:", err);
        });
      }, 1000); // 延迟1秒后处理下一个任务
    }
  } catch (error) {
    console.error("[QUEUE] 处理队列任务时发生错误:", error);
  }
}

export default router;
