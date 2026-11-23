# 架构说明

## 总览

```
┌──────────────────────────────┐
│ Android App（Capacitor）      │
│  ├─ 本地加密聊天记录          │
│  ├─ Keystore 会话 / BYOK Key │
│  └─ 本地打包的 Web 界面       │
└──────────────┬───────────────┘
               │ HTTPS（Bearer 会话 + 可选 BYOK 请求头）
┌──────────────▼───────────────┐
│ 自建 Node 服务端              │
│  ├─ 注册/登录、会话、限流      │
│  ├─ /api/chat SSE 转发        │
│  └─ SQLite：账号与运行元数据   │
└──────────────┬───────────────┘
               │ HTTPS（服务端 Key 或用户 BYOK Key）
┌──────────────▼───────────────┐
│ DeepSeek / OpenRouter API    │
└──────────────────────────────┘
```

浏览器端走同源 `/api/*`，服务端同时托管 `dist/` 静态文件。

## 请求与密钥

### BYOK

应用把用户 Key 保存在本机：

- Android：`SecretStore` 插件使用 Android Keystore AES-GCM 加密到 `provider.bin`。
- Web：`localStorage` 的 `palm-byok-v1`。

发送对话时，客户端只在 `/api/chat` 请求上附加：

```
X-Palm-Provider: deepseek | openrouter
X-Palm-Key: <用户的 Key>
X-Palm-Model: <可选模型名>
```

服务端在单次请求内构造上游客户端，转发后即丢弃，不写数据库、不写日志、不回显。请求没有 BYOK 头时使用 `.env` 中的默认 Key；两者都没有则进入演示模式。

### 服务端统一 Key

`.env` 的 `DEEPSEEK_API_KEY` 或 `OPENROUTER_API_KEY` 只存在于服务端进程环境。安卓安装包和前端构建产物中不含任何上游 Key。

## 数据边界

| 数据 | 位置 | 是否加密 |
| --- | --- | --- |
| 聊天正文 | 手机应用私有目录 | Android Keystore AES-GCM，按账号独立密钥 |
| 会话 Token | 手机 Keystore | AES-GCM |
| BYOK Key | 手机 Keystore / 浏览器 localStorage | 安卓加密；网页依赖浏览器存储 |
| 账号、密码哈希 | 服务端 SQLite | 密码 scrypt 哈希 |
| 请求状态、Token 用量 | 服务端 SQLite | 无正文 |
| 网页旧版历史（可选） | 服务端 SQLite | 仅 `ENABLE_LEGACY_HISTORY=true` 时写入 |

服务端数据库不包含聊天正文列。原生聊天通过 `/api/chat` 无状态转发，每次只带最近上下文。

## 并发与限流

- 全局同时生成上限：`SERVER_MAX_CONCURRENT`，默认 4。
- 单账号同一时间只允许一个生成请求。
- 登录、注册、聊天请求分别限流。
- 流式响应支持客户端停止、断线检测和上游超时。

## 安全措施

- 原生请求使用独立的 Bearer 会话，不复用 Web Cookie；原生来源必须精确匹配 `NATIVE_ALLOWED_ORIGINS`。
- CORS 白名单只允许 `Authorization`、`Content-Type`、`X-Palm-Client`、`X-Palm-Provider`、`X-Palm-Key`、`X-Palm-Model`。
- 服务端校验消息角色、长度、上下文大小和请求 ID 幂等。
- 正式 APK 强制 HTTPS、关闭 WebView 调试、`allowBackup=false`。
- 服务端返回 CSP、`X-Frame-Options: DENY`、`nosniff` 等安全头。

## 已知限制

- Node 服务端只支持文字聊天和旧版历史接口；文件、图片、语音和 TTS 不在开源版范围内。
- 没有云端聊天同步；换机请通过明文 JSON 导出/导入。
- 网页端 BYOK Key 存在浏览器 localStorage，若页面存在 XSS 风险，应优先使用 Android 客户端。
- 公共多用户部署时，用户 Key 会经过服务端内存。请使用 HTTPS、限制访问、关闭带请求头的访问日志，并向用户说明。
