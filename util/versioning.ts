/**
 * 生成当前时间戳作为版本号，格式为 YYYYMMDDHHmmss（本地时间）。
 * 例如：20250702144736
 */
export function generateTimestampVersion(): string {
  const now = new Date();
  const isProduction = process.env.NODE_ENV === "production";
  const pad = (num: number) => (num < 10 ? "0" + num : "" + num);

  // 生产环境使用 UTC 时间
  if (isProduction) {
    return (
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
        now.getUTCDate()
      )}` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(
        now.getUTCSeconds()
      )}`
    );
  }

  // 开发环境使用本地时间
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
