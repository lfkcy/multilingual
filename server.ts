require("dotenv").config(); // Load .env file

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fileUpload from "express-fileupload";
import i18nRouter from "./routes/i18n";

const app = express();
const PORT = process.env.PORT || 8888;

app.use(cors());
app.use(bodyParser.json());
app.use(
  fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // 限制文件大小为 10MB
    abortOnLimit: true,
  })
);

app.use("/api/i18n", i18nRouter);

app.listen(PORT, () => {
  console.log(`🚀 Express 服务已启动: http://localhost:${PORT}`);
});
