import { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

dotenv.config();

// 解析环境变量中的 JSON 字符串
const apiKeyMap: { [key: string]: string } = JSON.parse(
  process.env.API_KEY_PROJECT_MAPPING || "{}"
);

/**
 * 升级版 API Key 鉴权中间件，并附加项目 ID
 */
export const apiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  const clientApiKey = req.headers["x-api-key"] as string;

  // 寻找匹配的 API Key，并获取对应的项目 ID
  const projectId = Object.keys(apiKeyMap).find(
    (key) => apiKeyMap[key] === clientApiKey
  );

  if (!projectId) {
    console.warn(`[apiKeyAuth] 未找到匹配的 API Key: ${clientApiKey}`);
    res.status(401).json({
      code: 401,
      message: "Unauthorized: Invalid or missing API Key",
    });
    return; // 不返回 Response，只结束函数
  }

  // 将项目 ID 附加到请求对象上，供后续路由使用
  (req as any).projectId = projectId;

  next();
};
