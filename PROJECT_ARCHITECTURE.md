# 入群考试系统架构文档

## 1. 系统定位
本项目是一个“纯静态前端 + Cloudflare Worker 代理”的入群考试平台：

- 考生端与管理端均为静态页面（GitHub Pages 托管）
- 核心数据（题库与考试题）以加密文件形式存储在仓库 `data/` 目录
- 唯一后端是 `worker/exam-sync-worker.js`，用于代理 GitHub API，并承担受控的外部通知调用

该架构确保浏览器端不接触 GitHub PAT、NapCat Token 等敏感信息。

## 2. 代码拓扑与模块职责

- `index.html` + `js/exam.js`
  - 考生答题入口
  - 解密并加载 `data/exam.enc`
  - 本地评分、通过时生成凭证码
  - 提交后异步调用通知接口（不阻塞主流程）

- `admin.html` + `js/admin.js`
  - 管理员题库管理、导入导出、凭证验证
  - 维护 `bankData.settings`（含抽题数量与通知 Worker 地址）
  - 导出时将 `bankData.settings` 复制到 `examData.settings`，发布到 `data/exam.enc`

- `js/github-sync.js`
  - 管理端调用 Worker 的同步客户端封装
  - 使用 `X-Admin-Secret` 访问受保护路由

- `worker/exam-sync-worker.js`
  - GitHub 读写代理（`/api/check`、`/api/read`、`/api/write`）
  - 通知代理（`/api/notify`），用于将考试结果转发到 NapCat OneBot HTTP API
  - 统一处理 CORS、路径校验、管理员鉴权（通知端点除外）

- `data/exam.enc`
  - 考生可解密考试数据（不含明文答案）
  - 包含 `examData.settings.notifyWorkerUrl`

- `data/bank.enc`
  - 管理员可解密完整题库（含正确答案索引）
  - 包含 `bankData.settings.notifyWorkerUrl`

## 3. 核心数据与安全边界

### 3.1 数据分层
- `bank.enc`：完整题库与管理设置，使用管理员密码解密
- `exam.enc`：考试投放数据，使用站点密钥解密，避免泄露完整题库结构

### 3.2 敏感信息存放
- 仅 Worker 环境变量保存以下敏感配置：
  - `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` / `ADMIN_SECRET`
  - `NAPCAT_URL` / `NAPCAT_TOKEN` / `NOTIFY_TARGETS`
- 浏览器端只拿到 `notifyWorkerUrl`（Worker 公网地址），不拿到 NapCat Token

### 3.3 鉴权策略
- `/api/check`、`/api/read`、`/api/write`：必须校验 `X-Admin-Secret`
- `/api/notify`：公开端点，不要求 `ADMIN_SECRET`，但做请求体与 `playerID` 格式校验

## 4. 业务主链路

### 4.1 出题发布链路（管理员）
1. 管理员在 `admin.html` 编辑题库与设置（含通知 Worker 地址）
2. `handleExport()` 生成 `examData` 与 `bankData` 并分别加密
3. 若已配置 Worker，同步写入 GitHub `data/exam.enc` 与 `data/bank.enc`
4. GitHub Pages 自动部署后，考生端读取新版本 `exam.enc`

### 4.2 考试通知链路（新增）
1. 考生提交后，`js/exam.js` 调用 `_notifyResult(...)`
2. 前端向 `notifyWorkerUrl + /api/notify` 发送考试结果（异步、静默失败）
3. Worker 校验参数、解析 `NOTIFY_TARGETS`，按规则筛选接收目标
4. Worker 调用 NapCat API：
   - 私聊：`/send_private_msg`
   - 群聊：`/send_group_msg`
5. QQ 接收通知消息（通过可附带凭证码）

## 5. Worker API 概览

- `GET /api/check`：检查 GitHub 访问与写权限（管理员）
- `GET /api/read?file=data/*.enc`：读取允许范围内加密文件（管理员）
- `PUT /api/write`：批量写入加密文件，含题目数保护与冲突处理（管理员）
- `POST /api/notify`：接收考试结果并转发到 NapCat（公开）

## 6. 运维与发布要点

- 启用自动通知前，必须配置 Worker 环境变量：
  - `NAPCAT_URL`
  - `NAPCAT_TOKEN`
  - `NOTIFY_TARGETS`（JSON 数组字符串）
- 管理员在面板中填写“通知 Worker 地址”后，必须执行“加密并发布”，使配置进入 `exam.enc`
- 通知模块设计为“fire-and-forget”：任何通知失败均不影响考试评分与结果展示
