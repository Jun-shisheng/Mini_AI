# PalmChat 开源版

自带 API Key（BYOK）的开源 AI 聊天应用：React + Vite 前端、Node.js 自托管中继、Capacitor Android 客户端。聊天正文按账号加密保存在手机上，服务端不保存聊天正文。

- 支持 DeepSeek 与 OpenRouter，用户在应用内填入自己的 Key，或由部署者在服务端 `.env` 配置共用 Key。
- 没有套餐、支付、充值、邀请码和运营后台；要收费请自行二次开发并遵守当地法规。
- 没有预置服务器、没有预置密钥、没有预置域名；部署到自己的 HTTPS 地址即可。
- 不含遥测。服务端只记录账号、Token 哈希、请求状态和用量元数据。

> 本项目与 DeepSeek、OpenRouter 均无隶属关系。模型调用产生的费用由你自己的 API 账户承担。

## 两种填 Key 的方式

### 方式一：在应用内填自己的 Key（推荐给个人用户）

1. 启动服务端并打开网页版，或安装 Android 包。
2. 注册/登录一个本地账号。
3. 侧边栏或设置里点「模型与密钥」。
4. 选择 DeepSeek 或 OpenRouter，粘贴 API Key，可选填模型名，保存。
5. 回到对话直接聊天。应用内的 Key 会覆盖服务端 `.env` 中的默认 Key。

Key 的存放位置：

| 平台 | 存放方式 |
| --- | --- |
| Android | Android Keystore AES-GCM 加密文件，位于应用私有目录 |
| 网页 | 浏览器 `localStorage`（同源页面） |

请求路径：`App → 你自建的 HTTPS 服务端 → 模型提供方`。Key 只随 `/api/chat` 请求发送到你自己的服务端，服务端不会记录或回显 Key。**不要把它填进不可信的公共部署。**

### 方式二：服务端统一配置 Key（推荐给家庭/小团队共用）

~~~dotenv
# .env
DEEPSEEK_API_KEY=sk-your-own-key
CHAT_PROVIDER=deepseek
~~~

重启服务端后，所有账号默认使用这个 Key。应用内 BYOK 仍然优先。

OpenRouter：

~~~dotenv
CHAT_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-your-own-key
OPENROUTER_MODEL=openrouter/free
~~~

## 快速开始（网页 / PWA）

需要 Node.js 24+。

~~~bash
npm ci
cp .env.example .env
npm run dev
~~~

打开 http://localhost:5173。第一次使用先注册账号，然后到「模型与密钥」填入自己的 Key。没有 Key 时应用处于演示模式，只返回示例文字。

生产构建与启动：

~~~bash
npm run build
node --env-file=.env server/index.mjs
~~~

默认监听 `127.0.0.1:8787`，由同机 HTTPS 反向代理对外提供服务。详见 [部署说明](docs/DEPLOY.md)。

## 界面自定义

设置 →「账号与设置」里可以调整：

- 头像大小：小 / 标准 / 大
- 正文字号：小 / 标准 / 大
- 对话宽度：窄 / 标准 / 宽
- 消息间距：紧凑 / 标准 / 宽松
- 浅色 / 深色主题

这些选项保存在本机，可随时一键恢复默认。没有订阅、支付、兑换码、邀请、更新推送或分享链接抓取；开源版只保留聊天、账户、本机记录、文件导入导出和 BYOK。

## 自己打包 Android

需要 JDK 21、Android SDK Platform 36、Build Tools 36.0.0。

~~~bash
# 调试包（可连接局域网 HTTP 服务）
node scripts/android-build.mjs --api-url http://你的电脑局域网IP:8787 --allow-http

# 正式包（必须 HTTPS）
node scripts/android-build.mjs --release --unsigned \
  --api-url https://你的域名.example --version-code 1 --version-name 1.0.0
~~~

- 安装包的包名是 `com.example.palmchat`，正式发布前请改成自己的包名，并创建自己的签名证书。
- 构建脚本会在 `.android-sdk/` 下生成调试证书；该目录和所有 `*.keystore` 都不应提交。
- 安装包内不包含任何 API Key。

## 服务端配置

完整列表见 [.env.example](.env.example)。常用项：

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` | 可选的共用 Key；留空则依赖应用内 BYOK |
| `CHAT_PROVIDER` | `deepseek` 或 `openrouter` |
| `CHAT_MODEL` / `OPENROUTER_MODEL` | 默认模型名 |
| `HOST` / `PORT` | 监听地址与端口 |
| `ALLOW_REGISTRATION` | 是否开放注册 |
| `SERVER_MAX_CONCURRENT` | 全局同时生成上限 |
| `METADATA_RETENTION_DAYS` | 运行元数据保留天数 |
| `NATIVE_ALLOWED_ORIGINS` | 安卓 WebView 的精确来源，默认 `https://localhost`，禁止 `*` |

## 数据与隐私

- 安卓端聊天正文按账号使用 Android Keystore 的 AES-GCM 密钥加密，存放在应用私有目录。服务端不保存聊天正文。
- 网页端默认不保存云端聊天历史；只有显式设置 `ENABLE_LEGACY_HISTORY=true` 时才启用旧版服务端历史。
- 卸载应用、清除应用数据或丢失设备可能导致本机记录无法恢复，请先在应用内导出。导出文件是明文 JSON。
- 服务端 `data/` 目录包含账号、Token 哈希、请求状态和用量，需定期备份；不要提交到仓库。
- 服务端不记录 API Key，也不把 Key 写入数据库。反向代理请关闭请求头日志，或在日志配置中脱敏 `X-Palm-Key`。

## 测试

~~~bash
npm test
npm run build
~~~

测试覆盖认证、CORS、原生鉴权、无状态转发、BYOK 请求头、本地加密记录、导入导出、PWA 缓存等。测试使用本地假上游，不会消耗真实 API 额度。

## 目录

~~~
src/            React 界面、BYOK 设置、本机加密聊天
server/         Node.js 中继（鉴权、限流、SSE 转发、SQLite 元数据）
shared/         SSE 解析、DeepSeek 事件映射、历史导入
android/        Capacitor Android 工程与原生插件
scripts/        开发、构建、打包脚本
tests/          node:test 测试
docs/           架构与部署说明
~~~

## 许可

MIT，见 [LICENSE](LICENSE)。第三方依赖和模型服务分别遵循其自身许可与条款。
