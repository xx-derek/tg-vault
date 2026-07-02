<p align="center">
  <img src="backend/logo.png" alt="FlClouds Logo" width="150" />
</p>

<h1 align="center">FlClouds</h1>

<p align="center">
  <img src="https://img.shields.io/github/license/hicocos/FlClouds?style=flat-square&color=blue" alt="License" />
  <img src="https://img.shields.io/github/stars/hicocos/FlClouds?style=flat-square&color=gold" alt="Stars" />
  <img src="https://img.shields.io/github/forks/hicocos/FlClouds?style=flat-square&color=lightgrey" alt="Forks" />
  <img src="https://img.shields.io/github/issues/hicocos/FlClouds?style=flat-square&color=red" alt="Issues" />
  <img src="https://img.shields.io/badge/Docker-Compose-blue?style=flat-square" alt="Docker Compose" />
</p>

<p align="center">
  <strong>FlClouds</strong> 是一款面向个人和小团队的 Telegram 转存与私有云存储系统，支持频道/群组媒体转存、账号级 Telegram 下载、按日期抓取、订阅同步、自动按来源与文件类型归档，并提供 Web 管理、图片/视频预览和大文件上传能力。
</p>

---

## 🚀 快速部署 (Docker Compose)

### 1. 克隆仓库

```bash
git clone https://github.com/hicocos/FlClouds.git
cd FlClouds
```

### 2. 配置环境变量

```bash
cp .env.example .env
vi .env
```

至少建议先填写：

| 使用场景 | 需要填写/执行 |
| :--- | :--- |
| 基础 Web 部署 | `DB_PASSWORD`、`VITE_API_URL`、`CORS_ORIGIN`、`DOMAIN` |
| 启用 Telegram Bot 基础能力 | 额外填写 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_API_ID`、`TELEGRAM_API_HASH` |
| 启用账号级 Telegram 下载器 | 在 Bot 基础配置之后，运行登录脚本生成 `TELEGRAM_USER_SESSION_FILE` |

> Bot 基础能力包括：收文件、任务管理、存储统计、删除文件、yt-dlp 下载等。账号级下载器主要用于频道/群组批量抓取、订阅同步和超过 Bot 限制的大文件下载。

### 3. 构建前端

`VITE_API_URL` 是前端构建时变量。请先在 `.env` 中设置好它，然后用变量传入构建命令：

```bash
set -a
source .env
set +a

docker build \
  --build-arg VITE_API_URL="${VITE_API_URL}" \
  -t flclouds-frontend:latest \
  ./frontend
```

### 4. 构建后端

```bash
docker build -t flclouds-backend:latest ./backend
```

### 5. 生成用户账号 session（可选）

如果你要启用账号级 Telegram 下载器，请在启动服务前生成 session。该命令会使用 `docker-compose.yml` 中的 `/data` 持久化卷，默认写入 `.env` 里的 `TELEGRAM_USER_SESSION_FILE` 路径。

```bash
docker compose run --rm --no-deps backend npm run login:telegram-user
```

按提示登录 Telegram 后，确认 `.env` 中包含：

```env
TELEGRAM_USER_SESSION_FILE=/data/telegram_user_session.txt
```

如果暂时不使用账号级下载器，可以跳过这一步。

### 6. 启动服务

```bash
docker compose up -d
```

> [!IMPORTANT]
> 修改 `VITE_API_URL` 后必须重新构建前端镜像；仅重启容器不会改变已经打包进前端静态文件的 API 地址。

---

## 🛠️ 环境变量配置

| 变量名 | 说明 | 示例 | 获取说明 |
| :--- | :--- | :--- | :--- |
| `VITE_API_URL` | 前端访问后端的地址，必须包含协议 | `https://api.yourdomain.com` | 你的后端反代公网地址，例如 Nginx/Caddy 指向宿主机 `51947` |
| `DB_PASSWORD` | PostgreSQL 数据库密码 | `change_me_to_a_strong_password` | 自行生成强密码，首次部署前写入 `.env` |
| `CORS_ORIGIN` | 允许跨域的前端来源 | `https://cloud.yourdomain.com` | 你的前端网页公网地址，例如 Nginx/Caddy 指向宿主机 `47832` |
| `DOMAIN` | 应用主域名，不带协议 | `cloud.yourdomain.com` | 填前端主域名，用于生成链接和展示 |
| `TELEGRAM_BOT_TOKEN` | 可选，Telegram Bot Token；启用 Bot 基础能力时填写 | `123456:ABC-DEF...` | 找 [@BotFather](https://t.me/BotFather) 创建机器人后获取 |
| `TELEGRAM_API_ID` | 可选，Telegram API ID；Bot 和账号级下载器共用 | `123456` | 登录 [my.telegram.org](https://my.telegram.org) 创建应用后获取 |
| `TELEGRAM_API_HASH` | 可选，Telegram API Hash；Bot 和账号级下载器共用 | `abcdef123456...` | 与 `TELEGRAM_API_ID` 在同一页面获取 |
| `TELEGRAM_USER_SESSION_FILE` | 可选，用户账号 session 文件路径；不生成 session 时 Bot 基础功能仍可用 | `/data/telegram_user_session.txt` | 仅在需要频道/群组批量抓取、订阅同步或突破 Bot 大文件限制时，运行 `docker compose run --rm --no-deps backend npm run login:telegram-user` 生成 |
| `TELEGRAM_DOWNLOAD_WORKERS` | 可选，Telegram 并发分片请求数，建议 4-8 | `4` | 主要影响 Telegram 文件下载速度；调太高可能触发限流 |
| `DUPLICATE_FILE_MODE` | 可选，重复文件处理策略 | `copy` | `copy` 生成副本，`skip` 跳过同名同目录同大小文件；也可用 `/duplicate_mode` 调整 |
| `AUTO_CLEANUP_ORPHANS` | 可选，是否自动清理本地孤儿文件 | `true` | 只扫描本地 `UPLOAD_DIR`，不清理第三方云存储；可用 `/cleanup_settings` 关闭 |
| `YTDLP_BIN` | 可选，yt-dlp 可执行文件路径 | `yt-dlp` | 镜像内默认已安装；只有自定义环境找不到命令时才需要改 |
| `YTDLP_WORK_DIR` | 可选，yt-dlp 下载临时目录 | `./data/uploads/ytdlp` | 默认即可；需要独立磁盘目录时再改 |
| `YTDLP_MAX_CONCURRENT` | 可选，yt-dlp 并发任务数 | `1` | 按服务器 CPU、带宽和目标站点限速情况调整 |
| `TELEGRAM_RATE_WINDOW_MS` / `TELEGRAM_RATE_MAX` | 可选，Telegram Bot 普通消息限流窗口/次数 | `60000` / `30` | 防止单用户刷命令压垮服务 |
| `TELEGRAM_HEAVY_RATE_WINDOW_MS` / `TELEGRAM_HEAVY_RATE_MAX` | 可选，Telegram Bot 重型命令限流窗口/次数 | `600000` / `5` | 作用于 `/ytdlp`、`/tg_date`、`/tg_tag`、`/cleanup_settings` |

---

## 🤖 Telegram Bot 配置指南

集成 Telegram Bot 后，你可以通过聊天窗口上传文件、查看任务、删除文件、查看存储统计、调用 yt-dlp 下载视频链接。

| 能力 | 只启用 Bot | 额外启用账号级下载器 |
| :--- | :---: | :---: |
| 私聊发送文件给 Bot 转存 | ✅ | ✅ |
| 任务管理、存储统计、删除文件 | ✅ | ✅ |
| `/ytdlp` 下载视频链接 | ✅ | ✅ |
| 频道/群组按日期或标签批量抓取 | ❌ | ✅ |
| 频道订阅自动同步 | ❌ | ✅ |
| 超过 Bot 限制的大文件下载 | 可能失败 | 更稳定 |

账号级下载器不是 Bot 基础功能的前提；它只在需要用户账号可见性的频道/群组媒体、订阅同步或大文件下载时使用。

### 1. 获取 Bot Token

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather) 并开始对话。
2. 发送 `/newbot`，按提示创建机器人。
3. 复制 BotFather 返回的 `HTTP API TOKEN`。
4. 写入 `.env` 的 `TELEGRAM_BOT_TOKEN`。

### 2. 获取 API ID 和 API Hash

1. 访问 [my.telegram.org](https://my.telegram.org) 并登录 Telegram 账号。
2. 进入 `API development tools`。
3. 创建应用后复制 `api_id` 和 `api_hash`。
4. 写入 `.env` 的 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`。
5. 如果启用账号级下载器，继续运行 `docker compose run --rm --no-deps backend npm run login:telegram-user` 生成用户账号 session；它会复用同一组 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`。

### 3. 账号级下载器什么时候需要？

账号级下载器会用你登录的 Telegram 用户账号读取媒体。**不生成 session 时，Bot 基础能力仍然可用**；只有下面这些场景建议启用：

- 频道/群组转存：用户账号需要加入对应频道/群组，并确保能看到历史媒体。
- 按日期/标签批量抓取：`/tg_date`、`/tg_preview_date`、`/tg_download` 依赖用户账号访问来源消息。
- 频道订阅同步：`/tg_sub` 后台扫描依赖用户账号读取频道/群组新消息。
- 大文件下载：Bot 直接下载受 Telegram Bot 限制影响，账号级下载器通常更稳定。

私聊发普通文件给 Bot、任务管理、存储统计、删除文件、`/ytdlp` 不依赖账号级下载器。

> 不再提供桥接群/频道自动转发配置，避免额外权限和隐私复杂度。

### 4. Telegram 并发下载调参

`TELEGRAM_DOWNLOAD_WORKERS` 控制并发分片请求数，默认 `4`。

- `4`：默认推荐，稳定优先
- `8`：更均衡，适合日常大文件
- `12` / `16`：激进模式，需要二次确认，可能更容易遇到 Telegram 限流、断流或账号风险

> Telegram 单次 `upload.getFile` 请求最大约 512KB。这里调的是并发分片数，不是单请求大小。

---

## 🤖 Telegram Bot 可用命令

| 命令 | 描述 |
| :--- | :--- |
| `/start` | 验证身份并开始使用 Bot |
| `/help` | 获取详细帮助信息与使用说明 |
| `/setup_2fa` | 配置或准备双重验证 (TOTP) |
| `/storage` | 查看当前服务器磁盘与存储统计 |
| `/list` | 查看最近上传的文件列表 |
| `/tasks` | 查看当前传输任务队列和下载进度 |
| `/stop_tasks` | 强制停止所有下载任务 |
| `/download_workers` | 打开并发下载调参面板 (4 / 8 / 12 / 16) |
| `/duplicate_mode` | 设置重复文件跳过或生成副本 |
| `/cleanup_settings` | 设置自动清理开关，本地存储用户可关闭以防默认删除文件 |
| `/tg_date` | 按日期向导抓取 Telegram 频道/群组媒体，需要账号级下载器 |
| `/tg_preview_date` | 预览指定日期范围内可下载的 Telegram 媒体，需要账号级下载器 |
| `/tg_sub` | 管理 Telegram 频道订阅，支持查看、添加和取消订阅，需要账号级下载器 |
| `/delete <ID>` | 删除指定文件，支持 ID 前缀 |
| `/ytdlp <url>` | 解析视频链接并下载到当前存储源 |

> [!TIP]
> 多文件上传数量达到 9 个及以上时，Bot 会自动进入静默排队模式，避免刷屏；可随时用 `/tasks` 查看进度。

---

## 📡 Telegram 转存与订阅

频道/群组批量转存与订阅同步需要账号级 Telegram 下载器。启用后，系统会把频道/群组中的媒体转存到 FlClouds，并交给当前启用的存储源保存。

- `/tg_date`：按向导输入频道、开始日期和结束日期，抓取指定日期范围内的媒体
- `/tg_preview_date`：先预览日期范围内的媒体数量与概况，再决定是否下载
- `/tg_sub`：管理频道订阅；回复序号取消订阅，回复 `@channel_username` 或 `https://t.me/channel_username` 添加订阅
- 后台任务会记录入队、跳过、重复和失败状态，可通过 `/tasks` 查看进度
- 文件默认按来源/频道和类型归档，例如 `telegram/channel_username/images/`、`telegram/channel_username/videos/`

当来源名称缺失或包含特殊字符时，系统会使用安全 fallback，避免生成非法路径或重复嵌套目录。

---

## 📥 yt-dlp 视频下载

通过集成 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，你可以直接在 Telegram Bot 中发送视频链接，让服务器解析并下载到当前存储源。

**使用方法**：

```text
/ytdlp https://example.com/video
```

限制：仅支持单个链接；需要先通过 `/start` 验证身份；链接必须以 `http://` 或 `https://` 开头。

---

## 🔐 安全与访问控制

FlClouds 默认采用“首次初始化”模式保护 Web 和 API：

1. 服务启动后，首次访问 Web 页面会要求创建：
   - 网页管理员密码：至少 8 位，使用 `scrypt` 加盐哈希后保存到数据库。
   - Telegram Bot 4 位 PIN：仅用于 Bot `/start` 身份验证，同样使用 `scrypt` 加盐哈希保存。
2. 登录成功后，浏览器会获得 HttpOnly Cookie 会话，前端不再把访问 token 写入 `localStorage`。
3. 修改类请求会校验 `Origin`，请确保 `.env` 中的 `CORS_ORIGIN` 与前端公网地址一致。

> [!IMPORTANT]
> 生产环境请使用 HTTPS。默认 `COOKIE_SECURE=true` 时，浏览器只会在 HTTPS 下发送登录 Cookie；如果你只在本地 HTTP 调试，可临时设置 `COOKIE_SECURE=false`。

### 旧部署密码迁移

旧版本已写入数据库的 SHA-256 密码哈希仍可被识别，登录成功后建议尽快在设置中更新为新密码。全新部署请直接使用首次初始化流程创建网页管理员密码和 Telegram Bot 4 位 PIN。

### 自动密钥说明

FlClouds 会在首次启动时自动生成内部密钥，并保存到 Docker 数据卷的 `/data/secrets/` 目录中。正常部署无需手动配置。迁移服务器时请连同 Docker volume 一起备份，否则登录会话、TOTP 密钥和已加密的第三方存储凭证可能需要重新配置。

### 双重验证 (TOTP)

FlClouds 内置支持 TOTP 双重验证（如 Google Authenticator）：

- Web 端：在个人设置中扫码激活
- Telegram Bot：发送 `/setup_2fa` 获取设置二维码，并在对话框输入验证码激活
- 启用后，网页登录和使用 Bot 均需二次验证

---

## 🌐 反向代理建议

如果你使用 Nginx、Nginx Proxy Manager 或 Caddy 部署，请参考以下映射：

| 访问域名 | 协议 | 转发至宿主机 IP:端口 | 说明 |
| :--- | :--- | :--- | :--- |
| `cloud.example.com` | HTTPS | `127.0.0.1:47832` | 前端/网页入口 |
| `api.example.com` | HTTPS | `127.0.0.1:51947` | 后端/API 接口 |

如果前后端使用不同域名，请在后端环境变量中设置：

```env
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
COOKIE_SECURE=true
```

> [!CAUTION]
> 开启 HTTPS 后，`.env` 中的 `VITE_API_URL` 和 `CORS_ORIGIN` 都应使用 `https://`，否则浏览器可能拦截请求。修改 `VITE_API_URL` 后必须重新构建前端镜像，因为它会被打包进静态文件。

---

## 📦 Docker 镜像说明

默认从源码本地构建并使用以下镜像 tag：

- `flclouds-frontend:latest`
- `flclouds-backend:latest`
- `postgres:16-alpine`

如果你修改了前端 API 地址或前端源码，请重新执行前端构建步骤。

---

## 🔄 维护与更新

```bash
cd /root/FlClouds

git pull origin main

set -a
source .env
set +a

docker build \
  --build-arg VITE_API_URL="${VITE_API_URL}" \
  -t flclouds-frontend:latest \
  ./frontend

docker build -t flclouds-backend:latest ./backend

docker compose up -d
```

清理无用 Docker 资源：

```bash
docker system prune -f
```

---

## ✨ 功能特性

- 📦 大文件切片上传与断点续传
- 🖼️ 图片缩略图、视频预览与流式播放
- 🤖 Telegram Bot 上传、下载、删除、任务队列与存储统计
- 👤 Telegram 用户账号级 MTProto 下载器，支持频道/群组媒体转存
- 📅 按日期抓取、下载前预览与频道订阅同步
- 🔁 桥接群/频道转发，改善多人私聊媒体不可见问题
- 🗂️ 按来源/频道和文件类型自动归档，特殊名称安全 fallback
- ⚙️ Telegram 并发下载 worker 调参，激进模式带二次确认
- 🧯 重复文件处理、路径规则和本地孤儿文件清理开关
- 📥 yt-dlp 视频链接下载到当前存储源
- 🔐 首次 Web 初始化管理员密码，HttpOnly Cookie 会话与 Bot 独立 PIN
- 🛡️ Origin 校验、签名 URL、存储账户作用域隔离与本地路径安全保护
- ⚡ 前端按需加载与依赖拆包，降低首屏 JS 体积
- 🧩 Google Drive 等存储源配置与授权刷新
- 🐳 Docker Compose 容器化部署

---

## 📂 项目结构

```text
FlClouds/
├── frontend/           # React 网页前端
├── backend/            # Node.js API 与 Telegram 服务
├── init.sql            # 数据库初始化脚本
├── docker-compose.yml  # Docker Compose 部署配置
├── .env.example        # 环境变量模板
└── LICENSE             # MIT License
```

---

## 📄 开源协议

基于 [MIT License](LICENSE) 开源。

---

[![Star History Chart](https://api.star-history.com/svg?repos=hicocos/FlClouds&type=date&legend=top-left)](https://www.star-history.com/#hicocos/FlClouds&type=date&legend=top-left)
