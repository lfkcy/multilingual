import { run as syncI18n } from "./syncI18n";
import { generateTimestampVersion } from "./versioning";

export interface RunI18nSyncOptions {
  projectId: string | null;
  uploadedEnJsonContent: string | null;
  promoteToCurrent?: boolean;
  commitId?: string | null;
}

/**
 * 多语言同步
 */
export async function runI18nSync(options: RunI18nSyncOptions): Promise<void> {
  const {
    projectId,
    uploadedEnJsonContent,
    promoteToCurrent = false,
    commitId = null,
  } = options;

  // 生成当前时间戳作为版本号
  const currentVersion = generateTimestampVersion();
  console.log(`[runI18nSync] 本次同步任务的版本号: ${currentVersion}`);

  await syncI18n({
    currentVersion,
    uploadedEnJsonContent,
    projectId,
    promoteToCurrent,
    commitId: commitId ?? null,
  });
}
