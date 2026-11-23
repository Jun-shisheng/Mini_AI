# 部署说明

## 1. 准备

- Linux / Windows 服务器，Node.js 24+
- 一个可用的 HTTPS 域名（安卓正式包必须 HTTPS）
- 自己的 DeepSeek 或 OpenRouter API Key（也可以让用户在应用内填写）

~~~bash
git clone <你的仓库地址> palmchat
cd palmchat
npm ci
cp .env.example .env
npm run build
~~~

编辑 `.env`：

~~~dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
COOKIE_SECURE=true
ALLOW_REGISTRATION=true
# 可选：服务端共用 Key
# DEEPSEEK_API_KEY=sk-...
~~~

启动：

~~~bash
node --env-file=.env server/index.mjs
~~~

## 2. HTTPS 反向代理

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE：关闭缓冲，保持长连接
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_set_header Connection "";
    }
}
```

如果使用 Caddy，`reverse_proxy 127.0.0.1:8787` 默认即可。确保反向代理不会把 `X-Palm-Key` 写进访问日志；必要时在日志格式中删除该请求头。

## 3. 常驻运行

systemd 示例：

```ini
[Unit]
Description=PalmChat
After=network.target

[Service]
WorkingDirectory=/opt/palmchat
ExecStart=/usr/bin/node --env-file=.env server/index.mjs
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Windows 上请使用计划任务或服务管理器，不要依赖终端窗口；本项目不推荐用 `nohup` 保持进程。

## 4. 安卓安装包

~~~bash
node scripts/android-build.mjs --release --unsigned \
  --api-url https://chat.example.com --version-code 1 --version-name 1.0.0
~~~

产物在 `artifacts/`。正式发布前：

1. 把 `android/app/build.gradle` 的 `applicationId` 和 `capacitor.config.json` 的 `appId` 改成自己的包名。
2. 创建自己的签名证书，通过 `PALM_KEYSTORE`、`PALM_KEY_ALIAS`、`PALM_STORE_PASSWORD`、`PALM_KEY_PASSWORD` 注入后去掉 `--unsigned`。
3. 安装包必须指向自己的 HTTPS 服务端；安装包内不需要也不允许放 API Key。

## 5. 备份与升级

- 备份 `data/`（SQLite 与 `.storage-key`）。丢失 `.storage-key` 会导致旧网页历史无法解密。
- 升级：拉取代码、`npm ci`、`npm run build`、重启服务端；不要删除 `data/`。
- 修改数据库结构前先备份。当前开源版不包含迁移框架，升级前请核对 release notes。

## 6. 自检

~~~bash
curl https://chat.example.com/api/health
# {"ok":true,"mode":"demo"}          # 未配置服务端 Key
# {"ok":true,"mode":"live"}          # 已配置服务端 Key
~~~

`mode=demo` 时仍可在应用内填 BYOK Key 开始真实对话。

## 7. 关闭注册（可选）

家庭/个人部署可设置：

~~~dotenv
ALLOW_REGISTRATION=false
~~~

关闭后只能登录已有账号。首次部署请先开放注册创建账号，再关闭。
