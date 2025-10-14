# multilingual

多语言翻译管理工具

---

## 目录
- [项目简介](#项目简介)
- [主要特性](#主要特性)
- [依赖说明](#依赖说明)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [目录结构](#目录结构)
- [多语言版本号机制说明](#多语言版本号机制说明)
- [缓存与锁机制说明](#缓存与锁机制说明)
- [OSS 云存储说明](#oss-云存储说明)
- [智能翻译机制详解](#智能翻译机制详解)
- [工具函数说明（util/）](#工具函数说明util)
- [API 说明](#api-说明)
- [常见问题（FAQ）](#常见问题faq)
- [贡献指南](#贡献指南)
- [安全与最佳实践](#安全与最佳实践)

---

## 项目简介
本项目是一个企业级多语言翻译管理平台，专为前端项目设计，支持语言文件的版本化管理、智能翻译、自动同步和灰度发布。**核心特性包括 Commit ID 与语言版本的强关联映射、原子化版本切换、热修复支持，确保多语言内容与前端代码的完美同步。**

## 主要特性

### 🚀 核心功能
- **企业级多语言管理**：支持多语言 JSON 文件的增删查改，提供完整的 RESTful API 接口
- **智能翻译引擎**：集成 Google Gemini API，支持多密钥轮询、智能标识符识别、双重翻译机制
- **版本化管理**：每次同步/上传生成唯一版本目录，支持历史版本回溯与原子化切换
- **OSS 云存储**：基于阿里云 OSS 的大规模文件存储与分发

### 🔄 同步机制
- **自动同步**：上传/更新 en.json 时，自动对比并同步所有其他语言
- **手动同步**：支持接口手动触发多语言同步
- **增量翻译**：只翻译发生变化的 JSON 片段，提高效率
- **分段翻译**：将翻译任务分成小块处理，避免单次内容过大

### 🛡️ 安全与稳定性
- **API Key 认证**：支持多项目 API Key 映射，确保接口安全
- **文件锁机制**：多进程/多请求下保证同步任务安全执行
- **进程管理**：子进程执行同步任务，支持任务终止与重启
- **错误恢复**：翻译失败时保留原始文本，确保系统稳定性

### 🎯 企业级特性
- **Commit ID 映射**：语言版本与前端代码 Commit ID 强关联，支持精确回滚
- **灰度发布**：支持版本推广到 current 目录，实现原子化切换
- **热修复支持**：BMS 热修复场景，即时推广到生产环境
- **多项目支持**：通过 API Key 映射支持多个项目独立管理

## 依赖说明
主要依赖如下：
- `express`、`body-parser`、`cors`、`express-fileupload`：API 服务与文件上传
- `ali-oss`：阿里云 OSS 文件操作
- `@google/genai`、`undici`：Google Gemini 智能翻译
- `typescript`、`ts-node`：TypeScript 支持
- 详见 `package.json`

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
请参考 [环境变量配置](#环境变量配置) 部分，配置 OSS 及 Gemini API Key。

### 3. 启动开发/生产环境
```bash
npm run dev      # 开发模式，自动重载
npm run build    # 编译 TypeScript（如需）
npm start        # 启动服务（如配置）
```
或直接：
```bash
ts-node server.ts
```

## 环境变量配置
请在根目录下新建 `.env` 或 `.env.production` 文件，示例：
```ini
NODE_ENV=development  # 或 production
PORT=8888            # 服务端口

# OSS 配置
OSS_ACCESS_KEY_ID=xxx
OSS_ACCESS_KEY_SECRET=xxx
OSS_BUCKET=your-bucket
OSS_REGION=oss-cn-xxx

# Google Gemini API Key（支持多密钥，逗号分隔）
GEMINI_API_KEYS=key1,key2,key3

# API Key 项目映射（JSON 格式）
API_KEY_PROJECT_MAPPING={"project1":"api_key_1","project2":"api_key_2"}

# 代理配置（可选）
HTTP_PROXY=http://127.0.0.1:7890
```

### 配置说明
- **OSS 配置**：请在阿里云控制台获取相关参数
- **GEMINI_API_KEYS**：支持配置多个密钥，提升并发和稳定性
- **API_KEY_PROJECT_MAPPING**：JSON 格式的项目 ID 与 API Key 映射关系
  - 格式：`{"项目ID": "API_KEY", "项目ID2": "API_KEY2"}`
  - 客户端请求时需要在 Header 中携带 `x-api-key`
- **HTTP_PROXY**：用于配置代理服务器，解决网络访问问题
- **安全建议**：所有敏感信息仅通过环境变量传递，不要硬编码在代码中

## 目录结构
```
├── lang/            # 存放各语言 JSON 文件（OSS 同步）--- 测试使用
├── routes/          # 路由定义
│   └── i18n.ts      # 多语言相关接口
├── util/            # 工具函数与核心逻辑
│   ├── index.ts         # JSON 拍平/展开、锁机制等
│   ├── oss.ts           # OSS 工具
│   ├── translator.ts    # Gemini 智能翻译与缓存（核心翻译引擎）
│   ├── logger.ts        # 日志工具
│   ├── syncI18n.ts      # 多语言同步主逻辑（核心）
│   ├── runI18nSync.ts   # 同步子进程入口（仅调用 syncI18n）
│   ├── versioning.ts    # 版本号生成工具
│   ├── .sync_lock # 文件锁
├── cache/           # 翻译缓存与进度
│   ├── translation_cache.json      # 翻译缓存
│   ├── translation_progress.json   # 翻译进度
├── server.ts        # 服务入口
├── package.json     # 项目依赖
├── tsconfig.json    # TypeScript 配置
└── README.md        # 项目说明
```

- **OSS 目录结构说明**：
  - `assets/lang/` 下每次同步会生成一个以时间戳为名的子目录（如 `assets/lang/20250702144736/`），每个目录下存放该版本的所有语言文件。
  - 便于历史版本回溯、灰度发布、回滚等场景。

## 版本管理与 Commit ID 映射机制

### 🏷️ 版本号生成
- **格式**：`YYYYMMDDHHmmss`（如 `20250101120000`）
- **时间标准**：开发环境使用本地时间，生产环境使用 UTC 时间
- **唯一性**：每次同步/上传 en.json 时自动生成，确保版本号唯一
- **实现**：详见 `util/versioning.ts`

### 📁 目录结构
```
OSS Bucket/
├── assets/lang/
│   ├── 20250101120000/          # 版本目录
│   │   ├── en.json
│   │   ├── zh.json
│   │   └── ...
│   ├── 20250101130000/          # 另一个版本
│   │   ├── en.json
│   │   ├── zh.json
│   │   └── ...
│   └── current/                 # 当前生效版本
│       ├── en.json
│       ├── zh.json
│       └── ...
```

### 🔗 Commit ID 映射机制
系统支持 Commit ID 与语言版本的强关联映射，实现精确的版本控制：

#### 映射建立
- **触发条件**：上传 en.json 时携带 `commitId` 参数
- **存储位置**：`cache/cid_mapping.json`
- **映射格式**：`{"commitId": "version", "commitId2": "version2"}`
- **示例**：
```json
{
  "5808d368adb05d42cf760c3a4b9cc0567965bb1e": "20251013205520",
  "d0c24130": "20251014114821"
}
```

#### 版本推广流程
1. **建立映射**：前端 CI 上传 en.json 时携带 commitId，建立映射但不立即生效
2. **原子切换**：部署完成后调用 `promote-version` 接口，将对应版本复制到 `current` 目录
3. **精确回滚**：回滚时使用相同的 commitId，确保语言版本与代码版本完全一致

### 🔄 同步流程
1. **版本生成**：生成新的时间戳版本号
2. **内容对比**：对比 en.json 与上一版本的差异
3. **智能翻译**：对变化的内容进行增量翻译
4. **版本上传**：将所有语言文件上传到新版本目录
5. **映射记录**：如果提供 commitId，则建立版本映射关系

## 缓存与锁机制说明
- `cache/translation_cache.json`：缓存所有已翻译的文本对，加速重复翻译
- `cache/translation_progress.json`：记录当前 API 密钥索引
- `util/sync_lock`：同步任务文件锁，防止多进程/多请求并发导致数据冲突

## OSS 云存储说明
- 配置见 `util/oss.ts`，所有语言文件统一存储于阿里云 OSS（`assets/lang/`）
- **多版本目录结构**：每次同步/上传会在 `assets/lang/` 下生成新版本目录（如 `assets/lang/20250702144736/`），每个目录下存放该版本的所有语言文件。
- 支持文件上传、覆盖、读取、批量列举等操作
- **安全提示**：请勿将真实的 `accessKeyId` 和 `accessKeySecret` 直接暴露在生产环境，建议用环境变量或密钥服务管理

## 智能翻译机制详解

### 核心特性

#### 1. 智能标识符识别
系统内置 `isLikelyIdentifierOrCode` 函数，自动识别并跳过不应翻译的字符串：
- **文件标识符**：包含下划线或连字符且无空格的字符串（如 `image_1`, `btn-primary`）
- **纯数字字符串**：如 `123`, `456`
- **系统值**：以特定前缀开头的字符串（如 `img_`, `btn_`, `ID_`）
- **枚举值**：纯小写或纯大写且较短的单词（如 `pending`, `SUCCESS`）
- **JSON 字符串**：有效的 JSON 对象或数组
- **特殊字符**：包含大量非字母数字字符的字符串

#### 2. 双重翻译机制
采用两阶段翻译策略，确保翻译质量和完整性：

**第一阶段：JSON块翻译**
- 将整个JSON片段发送给Gemini进行批量翻译
- 使用严格的JSON翻译指令，确保结构完整性
- 自动跳过标识符和系统值

**第二阶段：单行字符串二次修复**
- 对比原始JSON和翻译结果，找出未翻译的字符串
- 对遗漏的字符串进行单独翻译
- 确保所有可翻译文本都得到处理

#### 3. 分段翻译策略
- **增量翻译**：只翻译发生变化的JSON片段
- **分块翻译**：将需要翻译的键值对分成小块（默认每块100个键），避免单次翻译内容过大
- **JSON结构保持**：翻译前后保持原始JSON的嵌套结构，通过flatten/unflatten处理
- **提高效率**：减少API调用次数，提升翻译速度
- **降低风险**：单个片段失败不影响整体翻译

#### 4. 多密钥轮询与容错
- **自动切换**：当API密钥配额耗尽时自动切换到下一个密钥
- **重试机制**：支持多次重试，提高翻译成功率
- **节流控制**：API调用间隔控制，避免触发频率限制
- **错误恢复**：翻译失败时保留原始文本，确保系统稳定性

#### 5. 翻译指令优化
针对不同场景设计了专门的翻译指令：

**JSON结构翻译指令**：
- 严格保持JSON结构完整性
- 只翻译用户可读的文本值
- 保护占位符和特殊标记
- 输出纯JSON格式

**单行字符串翻译指令**：
- 针对单个字符串的精确翻译
- 更低的温度设置，提高翻译准确性
- 简化的输出格式

### 翻译流程示例

```json
// 原始英文JSON
{
  "welcome": {
    "title": "Welcome to our app",
    "button": "btn_start",
    "message": "Click {{button}} to begin your journey"
  }
}

// 翻译过程
1. 识别标识符：跳过 "btn_start"
2. JSON块翻译：翻译整个welcome对象
3. 二次检查：确保所有可翻译文本都已处理
4. 最终结果：
{
  "welcome": {
    "title": "欢迎使用我们的应用",
    "button": "btn_start",
    "message": "点击 {{button}} 开始您的旅程"
  }
}
```

## 工具函数说明（util/）
- `index.ts`：
  - `flatten/unflattenJSON`：JSON 拍平与还原，便于多语言 key 对齐
  - `isJsonChanged`：判断 JSON 是否有变动
  - `chunkArray`：将数组切分为指定长度的子数组
  - `acquireLock/releaseLock`：文件锁，保证同步任务互斥
- `oss.ts`：OSS 工具类，封装了文件上传、下载、列举等常用操作
- `translator.ts`：**Google Gemini 智能翻译引擎**
  - 智能标识符识别与过滤
  - 双重翻译机制（JSON块 + 单行修复）
  - 多密钥轮询与容错处理
  - 翻译缓存
  - 代理支持与节流控制
- `logger.ts`：日志输出，记录每次多语言同步的新增、更新、删除项
- `syncI18n.ts`：多语言同步主逻辑（核心实现，负责 en.json 变更时自动同步所有语言）
- `runI18nSync.ts`：用于子进程执行多语言同步，仅作为 syncI18n 的调用入口，防止主进程阻塞
- `versioning.ts`：版本号生成工具，支持本地/UTC 时间

## API 说明

### 🔐 认证机制
所有 API 接口都需要在请求头中携带 API Key：
```http
x-api-key: your_api_key_here
```

### 📋 获取所有语言文件列表
- `GET /api/i18n/get-langs`
- **参数**：
  - `version`（可选）：指定版本号，不传则获取最新版本
- **返回**：
```json
{
  "code": 0,
  "data": {
    "count": 3,
    "files": [
      {"name": "en.json", "size": 1234, "lastModified": 1710000000000, "etag": "..."},
      {"name": "zh.json", "size": 1234, "lastModified": 1710000000000, "etag": "..."}
    ]
  }
}
```

### 📄 获取指定语言 JSON 内容
- `GET /api/i18n/get-lang?lang=xx`
- **参数**：
  - `lang`：语言代码（如 en、zh、fr）
  - `version`（可选）：版本号，不传则获取最新版本
- **返回**：
```json
{
  "code": 0,
  "data": {
    "hello": "你好",
    "welcome": "欢迎"
  }
}
```

### 📤 上传/更新指定语言 JSON 文件
- `POST /api/i18n/update-lang`
- **请求格式**：`multipart/form-data`
- **参数**：
  - `file`：JSON 文件（文件名需为 `xx.json`）
  - `version`（可选）：目标版本号，不传则使用最新版本
  - `commitId`（可选）：提交 ID，用于建立版本映射
  - `promoteToCurrent`（可选）：是否立即推广到 current 目录
- **行为**：
  - 上传 `en.json` 时自动触发多语言同步，生成新版本目录
  - 其他语言文件直接更新到指定版本
- **返回**：
```json
{
  "code": 0,
  "message": "en.json 更新成功，并已触发多语言同步任务。"
}
```

### 📊 获取版本列表
- `GET /api/i18n/get-versions`
- **返回**：
```json
{
  "code": 0,
  "data": ["20250101120000", "20250101130000", "20250101140000"],
  "isAsyncing": false
}
```

### 🔄 获取同步状态
- `GET /api/i18n/get-is-asyncing`
- **返回**：
```json
{
  "code": 0,
  "data": {
    "isAsyncing": false
  }
}
```

### 🚀 版本推广
- `POST /api/i18n/promote-version`
- **参数**：
  - `commitId`：提交 ID，用于查找对应的语言版本
- **行为**：将指定版本复制到 `current` 目录，实现原子化切换
- **返回**：
```json
{
  "code": 0,
  "data": {
    "commitId": "abc123",
    "version": "20250101120000",
    "target": "current"
  },
  "message": "版本 20250101120000 已成功推广到 current 目录。"
}
```

## 使用指南

### 📋 使用场景

#### 场景一：前端部署流程（推荐）
适用于前端 CI/CD 流程，确保语言版本与代码版本完全同步：

1. **构建阶段**：前端构建时上传 en.json
```bash
curl -X POST \
  -H "x-api-key: your_api_key" \
  -F "file=@en.json" \
  -F "commitId=abc123" \
  -F "promoteToCurrent=false" \
  http://localhost:8888/api/i18n/update-lang
```

2. **部署阶段**：部署完成后推广版本
```bash
curl -X POST \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"commitId": "abc123"}' \
  http://localhost:8888/api/i18n/promote-version
```

#### 场景二：BMS 热修复
适用于紧急修复场景，立即生效：

```bash
curl -X POST \
  -H "x-api-key: your_api_key" \
  -F "file=@en.json" \
  -F "promoteToCurrent=true" \
  http://localhost:8888/api/i18n/update-lang
```

#### 场景三：手动同步
适用于需要手动触发同步的场景：

```bash
# 上传 en.json 触发自动同步
curl -X POST \
  -H "x-api-key: your_api_key" \
  -F "file=@en.json" \
  http://localhost:8888/api/i18n/update-lang
```

## 常见问题（FAQ）

### 🔐 认证与权限
**Q: API Key 认证失败怎么办？**
- 检查请求头中是否携带 `x-api-key`
- 确认 API Key 在 `API_KEY_PROJECT_MAPPING` 环境变量中正确配置
- 验证项目 ID 与 API Key 的映射关系是否正确

**Q: 如何为多个项目配置不同的 API Key？**
- 在环境变量中配置 `API_KEY_PROJECT_MAPPING`，格式为 JSON 对象
- 示例：`{"project1": "key1", "project2": "key2"}`

### 🤖 翻译相关
**Q: Gemini API Key 如何配置？**
- 推荐将多个 Key 用逗号分隔写入 `.env` 文件的 `GEMINI_API_KEYS` 变量
- 支持多密钥轮询，提高翻译成功率和并发能力
- 生产环境请勿使用硬编码的 API Key

**Q: 为什么有些字符串没有被翻译？**
- 系统会自动识别标识符、代码、系统值等，这些字符串不会被翻译以保持功能完整性
- 识别规则包括：文件标识符、纯数字、系统值前缀、JSON 字符串等
- 如需强制翻译某个字符串，可以修改 `isLikelyIdentifierOrCode` 函数的判断逻辑

**Q: 翻译质量如何保证？**
- 采用双重翻译机制：JSON块翻译 + 单行字符串二次修复
- 使用严格的翻译指令，确保只翻译用户可读的文本
- 支持多密钥轮询，提高翻译成功率
- 智能缓存机制，避免重复翻译相同内容

### 🗂️ 版本管理
**Q: 版本号如何生成？**
- 由系统自动生成，格式为 `YYYYMMDDHHmmss`
- 开发环境使用本地时间，生产环境使用 UTC 时间
- 每次同步/上传 en.json 时自动生成新的版本号

**Q: Commit ID 映射机制如何工作？**
- 上传 en.json 时携带 `commitId` 参数，系统会建立映射关系
- 映射存储在 `cache/cid_mapping.json` 文件中
- 通过 `promote-version` 接口可以根据 commitId 查找并推广对应版本

**Q: 如何获取历史版本的语言包？**
- 使用 `get-lang?lang=xx&version=20250101120000` 获取指定版本
- 通过 `get-versions` 接口获取所有可用版本列表
- 也可通过 OSS 管理后台手动下载

### 🔧 配置与部署
**Q: OSS 配置报错怎么办？**
- 检查 `.env` 文件中的 OSS 相关参数是否正确
- 确认 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_REGION` 都已配置
- 建议不要硬编码在代码中，使用环境变量管理

**Q: 如何处理网络访问问题？**
- 系统支持 HTTP 代理配置，可在环境变量中设置 `HTTP_PROXY`
- 默认代理地址为 `http://127.0.0.1:7890`，可根据实际情况调整
- 生产环境建议部署在海外服务器，避免网络访问限制

**Q: 如何本地调试？**
- 推荐使用 `npm run dev` 启动开发模式
- 配置本地代理（如需 Gemini 访问）
- 检查 `cache/` 目录下的日志文件，了解同步进度

### 🔄 同步与缓存
**Q: 翻译缓存和进度如何清理？**
- 删除 `cache/translation_cache.json` 清理翻译缓存
- 删除 `cache/translation_progress.json` 重置 API 密钥索引
- 删除 `cache/cid_mapping.json` 清理 Commit ID 映射（谨慎操作）

**Q: 同步任务被锁定了怎么办？**
- 检查 `util/.sync_lock` 文件是否存在
- 如果文件存在但同步任务已停止，可以手动删除该文件
- 重启服务会自动清理过期的锁文件

**Q: 如何扩展支持更多语言？**
- 在现有语言目录中新增语言文件（如 `fr.json`）
- 调用同步接口，系统会自动识别并添加到支持列表
- 新语言会使用相同的翻译引擎进行翻译

### 🚨 故障排除
**Q: 同步任务失败怎么办？**
- 检查 Gemini API Key 是否有效且有足够配额
- 确认 OSS 配置正确，有足够的存储空间
- 查看服务日志，定位具体错误原因
- 可以重新上传 en.json 触发新的同步任务

**Q: 版本推广失败怎么办？**
- 确认 commitId 在映射表中存在
- 检查目标版本目录是否完整
- 验证 OSS 权限是否足够进行文件复制操作

**Q: 前端获取语言包失败怎么办？**
- 检查 API Key 是否正确配置
- 确认请求的版本号是否存在
- 验证网络连接和代理配置

## 贡献指南
1. Fork 本仓库并新建分支。
2. 提交 PR 前请确保通过所有测试。
3. 建议补充注释和文档。
4. 欢迎 issue 反馈和建议。

## 安全与最佳实践

### 🔒 安全措施
- **敏感信息保护**：所有 API Key、OSS 密钥等敏感信息通过环境变量管理，禁止硬编码
- **API 认证**：所有接口都需要 API Key 认证，支持多项目隔离
- **文件安全**：`.gitignore` 已默认忽略 `lang/`、`node_modules/`、`cache/` 等目录
- **HTTPS 部署**：生产环境建议使用 HTTPS 部署，保护接口安全
- **翻译安全**：系统会自动过滤敏感内容，避免翻译不当信息

### 📋 最佳实践
- **版本管理**：使用 Commit ID 映射机制，确保语言版本与代码版本同步
- **原子操作**：通过 `promote-version` 接口实现版本的原子化切换
- **缓存策略**：合理利用翻译缓存，提高翻译效率
- **监控告警**：建议配置同步任务监控，及时发现异常
- **备份策略**：定期备份 `cache/cid_mapping.json` 等重要文件

### 🚀 性能优化
- **多密钥轮询**：配置多个 Gemini API Key，提高并发能力
- **增量翻译**：只翻译变化的内容，减少 API 调用
- **分段处理**：大文件分段翻译，避免单次请求过大
- **代理配置**：合理配置代理，优化网络访问

### 📊 监控与维护
- **日志记录**：系统会记录详细的同步日志，便于问题排查
- **状态监控**：通过 `get-is-asyncing` 接口监控同步状态
- **版本追踪**：通过 `get-versions` 接口追踪版本历史
- **定期清理**：定期清理过期的缓存文件和锁文件

## 开发计划

### 🎯 已完成功能
- ✅ 多语言文件管理（增删查改）
- ✅ 智能翻译引擎（Google Gemini）
- ✅ 版本化管理（时间戳版本号）
- ✅ Commit ID 映射机制
- ✅ API Key 认证
- ✅ 原子化版本切换
- ✅ 多项目支持
- ✅ 进程管理与任务锁
- ✅ 缓存与进度管理

### 🔄 待优化功能
- 🔄 新增语言支持（在现有语言目录中新增语言文件并调用同步接口）
- 🔄 文件锁过期处理（优化同步任务的锁机制，避免死锁）
- 🔄 并发上传处理（优化多人同时上传 en.json 的处理逻辑）
- 🔄 分支权限控制（只有 master 分支才能触发同步流程）
- 🔄 同步完整性保证（确保所有语言都同步成功后再创建版本目录）

### 🚀 未来规划
- 📋 管理后台界面
- 📊 翻译质量评估
- 🔍 版本差异对比
- 📈 使用统计与分析
- 🔔 实时通知机制
- 🌐 更多翻译引擎支持

---

如有问题欢迎提交 issue 或 PR 共同完善本项目。
