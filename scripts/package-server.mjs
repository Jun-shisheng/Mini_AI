import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'server/index.mjs', 'server/store.mjs', 'server/provider.mjs',
  'shared/import.mjs', 'shared/provider-stream.mjs', 'shared/deepseek-events.mjs',
  '.env.example',
];
const files = {};
for (const name of sources) files[name] = new Uint8Array(await readFile(resolve(root, name)));
files['DEPLOY.txt'] = strToU8(`PalmChat 最小服务端

需要 Node.js 24+，使用内置 SQLite，无需 npm install、Redis 或额外数据库。

方式一：在应用内填入自己的 API Key（BYOK），服务端 .env 可以不配密钥。
方式二：把 DEEPSEEK_API_KEY 或 OPENROUTER_API_KEY 写入服务端 .env，供所有账号共用。
应用内填写的 Key 优先于服务端默认密钥。

1. 解压至专用目录。
2. 将 .env.example 复制为 .env，按需填写服务端密钥。
3. HOST=127.0.0.1 适合通过同机 HTTPS 反向代理访问。
4. 启动：node --env-file=.env server/index.mjs
5. 在 HTTPS 反向代理中关闭 SSE 缓冲，保持长连接。
6. 安卓安装包用 --api-url https://你的域名 构建。

原生允许来源默认为 https://localhost，按实际精确配置，不可用 *。
服务端只保存账号、Token 哈希、请求状态与用量元数据；聊天正文保存在手机本机。
默认全局 4 个生成、每账号 1 个，运行元数据保留 90 天。

本压缩包不含用户数据、实际 .env、API 密钥、Android SDK、node_modules 或前端资源。
如需网页版，在仓库执行 npm run build，把 dist/ 放到同一目录。
备份服务器的 data/ 目录；App 聊天在各手机上，请用户自行导出。
`);
const archive = zipSync(files, { level: 6 });
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const output = resolve(root, 'artifacts', 'palmchat-server.zip');
await writeFile(output, archive);
console.log(JSON.stringify({ path: output, bytes: archive.length, files: Object.keys(files),
  sha256: createHash('sha256').update(archive).digest('hex') }));
