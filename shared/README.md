# 聊天记录导入

`import.mjs` 是浏览器与服务端共用的纯 JavaScript 模块，无依赖、无网络访问。独立实现依据 DeepSeek 官方公开的 [v3 归档说明](https://github.com/deepseek-ai/chat-demo/blob/main/src/services/chat/history/README.md) 与字段定义，没有复制上游实现代码。

```js
import { normalizeImport, ImportError, IMPORT_LIMITS } from './shared/import.mjs';

const result = normalizeImport(input);
// { conversations: [{title, messages: [{role: 'user' | 'assistant', content}]}], warnings: [] }
```

PalmChat 当前导出 JSON 会写入 `exportedBy` 和 `contentNotice` 说明来源与 AI 内容。识别备份仍使用 `format: "palm-history"` 和 `version: 1`，导出为明文，分享前请检查正文中的私人信息。

支持：

- DeepSeek 第 3 版 ZIP 先解压、解析 JSON 后传入 `[{filename, data}]`。验证 manifest 版本、会话文件名与索引对应关系、消息数量和消息树。`user.json` 与图片文件不会导入。
- 单个 DeepSeek 会话 JSON：`messages`、`id` / `parent_id`、`current_message_id`、`fragments`。
- ChatGPT JSON：`mapping`、`parent`、`current_node`；只导入选中分支。
- 通用 `{title, messages:[{role, content}]}`、该格式数组，或含 `conversations` 等显式会话数组的容器。
- PalmChat 原生 `{format:'palm-history',version:1,conversations:[{title,persona,messages}]}` 备份：恢复用户显式导出的角色名字、简介、设定与重要记忆，仅保留这四个白名单字段。前后端二次归一化时须保留此格式封套；普通外部 JSON 中的 `persona` 不会自动恢复。
- TXT / Markdown 角色标记：`用户：`、`助手：`、`User:`、`Assistant:`、`### 用户` 等。代码围栏内的角色样例不会被拆成新消息。没有标记的文本作为一条用户消息导入并提示警告。

边界：

- 只导入用户和助手的正文。不会把 system / developer / tool、历史思考、模板拒绝、工具结果或附件提升为系统提示。
- 原生备份的可选 `persona` 仅允许文字字段 `name`（80 字符）、`description`（2,000）、`systemPrompt` 和 `memory`（各 16,000）；超限报错，不恢复密钥、账户或其他未知字段。此功能恢复的是用户明确导出的人设，不会从历史 system 消息推断人设。
- 遇到多个分支但缺少当前分支标记，拒绝猜测，不把兄弟分支拼接。
- 原始分享链接不在这里抓取：`shared/import.mjs` 返回 `SHARE_LINK_UNSUPPORTED`。开源版不提供云端分享链接抓取；请从 DeepSeek 导出 ZIP/JSON/TXT/Markdown 后导入。
- 出错时抛带中文说明的 `ImportError`，其 `code` 可用于界面判断；模块不会写入任何存储。
- 上限：原始文本或 JSON 约 20 MiB、100 个会话、20,000 条消息、单条正文 200,000 字符、累计正文 8,000,000 字符。超限报错，不静默截断正文。
- ZIP 解压方仍须限制解压后大小、文件数、单个条目大小并处理损坏或加密归档。此模块不接受 ZIP 二进制，也不读取磁盘路径。

运行针对格式还原、分支隔离、错误处理及数据边界的测试：

```sh
node --test tests/import.test.mjs
```
