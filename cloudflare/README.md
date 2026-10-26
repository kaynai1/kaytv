# KayTV 云后台（Cloudflare Pages）

可选的云端控制台：管理影视源、直播源、TVBox 配置、公告和云账号。
三端不依赖它也能照常看片；配置后，源和公告会自动同步到 Windows、手机和 TV。

## 能力

- **源管理**：影视 CMS、直播 m3u/txt、TVBox 配置的增删改查、排序、启停、一键检测延迟与可用性；支持设置源过期时间。
- **源定时体检**：定时 Worker 每 30 分钟分批探测所有启用源，连续失败达到阈值（默认 2 次）自动生成告警；源过期前也会提醒。
- **告警中心**：可用性 / 过期告警列表，支持单条或全部标记已处理，客户端可见的源异常一眼掌握。
- **公告**：标题 / 正文 / 级别 / 跳转链接 / 定时上下线，三端顶部横幅展示。
- **用户注册**：开放注册 / 邀请码注册 / 关闭注册三种模式，可设置自动通过或人工审核；支持停用、恢复、删除。
- **邀请码**：批量生成 `KAY-XXXX-XXXX` 邀请码，限制使用次数和有效期，可作废。
- **登录设备会话**：查看账号的登录设备、IP、最近活跃时间，支持踢出单台设备或全部其他设备。
- **操作审计日志**：管理端所有写操作（源、公告、用户、设置、邀请码、反馈）都记录操作人、动作、目标、详情和时间，可按关键词检索。
- **求片 / 反馈**：客户端内置反馈入口，匿名也可提交；管理端可查看、标记完成、回复备注、删除。
- **最低版本强制更新**：云端设置 `minVersion` 后，低于该版本的客户端会显示强制更新弹窗。
- **云同步**：登录后的收藏和观看进度在三端合并（可选，不登录不影响看片）。
- **零服务器**：全部跑在 Cloudflare Pages + D1 免费额度内。

## 当前部署

- 地址：<https://tv.9ky.us.ci>（打开就是管理页；旧地址 <https://kaytv-hub.pages.dev> 仍可用）
- D1 数据库 `kaytv-hub`，绑定变量 `DB`
- 管理员口令只存在 Cloudflare Secret `ADMIN_TOKEN` 中，不在仓库里
- 定时体检 Worker `kaytv-hub-cron`，每 30 分钟调用一次内部体检接口

客户端默认已内置这个地址，无需填写；想换自己的部署时，在「设置 → 云后台」改地址即可。

## 从零部署

需要 Node.js 22+（Wrangler 4 要求），在 `cloudflare/` 目录执行。如果本机是 Node 20，请改用 `npx wrangler@3.114.0`。

```bash
# 1. 登录 Cloudflare
npx wrangler login

# 2. 建 D1 数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create kaytv-hub

# 3. 建表（远程）
npx wrangler d1 execute kaytv-hub --remote --file=./schema.sql

# 4. 建 Pages 项目并首次部署（functions/ 会自动上传）
npx wrangler pages project create kaytv-hub --production-branch main
npx wrangler pages deploy --project-name kaytv-hub

# 5. 设置管理员口令（建议 24 位以上随机字符）
npx wrangler pages secret put ADMIN_TOKEN --project-name kaytv-hub
```

打开 `https://<项目名>.pages.dev`，输入 `ADMIN_TOKEN` 登录。

已有旧版本数据库升级：依次执行 `migrations/` 下尚未应用的 SQL（如 `2026-10-26-v0.5.0.sql`、`2026-10-26-v0.6.0.sql`），再重新部署 Pages。

> 只在 Cloudflare 控制台操作也可以：Workers & Pages → Create → Pages → 连接仓库或上传，
> 构建输出目录填 `admin`；在 D1 控制台粘贴 `schema.sql` 执行；
> 项目 Settings → Bindings 添加 D1，变量名必须是 `DB`；
> Settings → Variables and Secrets 添加 `ADMIN_TOKEN`，然后重新部署。

## 定时体检 Worker

Pages Functions 不支持定时任务，体检由独立 Worker 触发：

```bash
cd cron
# 生成随机令牌，同时写进 Worker Secret 和 Pages Secret（两边必须一致）
npx wrangler secret put CRON_TOKEN

cd ..
npx wrangler pages secret put CRON_TOKEN --project-name kaytv-hub

# 部署 Worker，首次会按 wrangler.toml 注册每 30 分钟的 Cron Trigger
cd cron
npx wrangler deploy
```

- Worker 配置里的 `HUB_URL` 指向云后台地址，默认 `https://tv.9ky.us.ci`
- 每轮最多探测 4 个最久未检查的源，自动续跑直到本轮全部完成，不会集中在同一分钟打满请求
- 也可以在管理页「概览 → 源体检与告警」手动点「立即体检」
- 想临时手动触发 Worker：`curl -X POST -H "Authorization: Bearer $CRON_TOKEN" https://kaytv-hub-cron.<账户子域>.workers.dev/run`

## 看剧AI 云端代签

「看剧AI」面板（左侧第三个标签）可以不重新打包就换源：

- 填官网地址（如 `https://kanju78.com`）→ 点「开始识别」：云端会打开官网、读取页面脚本、提取签名密钥与客户端标识，并用官方接口实测，通过才保存
- 密钥只存 D1，接口只返回掩码（`557d…54a0`），管理页和客户端都看不到明文
- 0.5.1 起的三端自动改走 `/api/kanju/*` 代理；0.5.0 及更早版本仍用打包时注入的密钥
- 遇到上游 401/403 会自动重新识别（默认开），也可以手动点「重新识别签名」或临时停用
- 代理只放行 `/v1/browse`、`/v1/catalog`、`/v1/playback` 三类接口，单次响应上限 3MB

## 客户端接入

三端「设置 → 云后台」可查看连接状态；换成自己的部署时粘贴项目地址 → 保存并同步。
云源只在客户端内置模式（下载即用）下生效；连接 NAS 服务端时仍以 NAS 的源为准。

想让新安装的包自带默认地址：在 GitHub 仓库 Settings → Secrets and variables → Actions →
Variables 添加 `KAYTV_CLOUD_URL`，下次 release 构建会自动写入客户端。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 公开配置：公告 + 启用的源 + 注册模式 + 最低版本 |
| POST | `/api/register` | 注册云账号（邀请码模式下需带 `inviteCode`） |
| POST | `/api/login` | 登录，返回 Bearer token，并登记登录设备 |
| GET | `/api/me` | 当前账号 |
| GET | `/api/sessions` | 当前账号的登录设备列表 |
| POST | `/api/sessions/revoke` | 踢出指定设备（踢自己即退出登录） |
| POST | `/api/sessions/revoke-others` | 踢出除当前设备外的所有会话 |
| GET/PUT | `/api/sync` | 拉取 / 推送收藏和观看进度 |
| POST | `/api/feedback` | 提交求片 / 反馈（匿名可提交） |
| GET | `/api/feedback` | 当前账号的反馈记录 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/internal/health-sweep` | 内部体检入口，需 `Authorization: Bearer CRON_TOKEN` |
| * | `/api/admin/*` | 管理接口，需 `Authorization: Bearer ADMIN_TOKEN` |

## 安全

- `ADMIN_TOKEN` 与 `CRON_TOKEN` 只放 Cloudflare Secrets，不要提交到仓库或前端构建。
- 用户密码使用 PBKDF2-SHA256（10 万次迭代 + 随机盐）存储，生产环境 Workers 的迭代上限。
- 登录会话 token 只存哈希，客户端拿到的是可撤销的会话 ID；会话 30 天过期。
- 管理接口与公共接口分离；写入接口限制字段长度和 URL 协议。
- 反馈接口按 IP 限流（15 秒一次），避免匿名刷屏。
- 云同步单账号上限 512KB，防止滥用免费额度。

## 免费额度参考

D1 免费版每天 500 万行读、10 万行写；Pages 静态和 Functions 每天 10 万次请求。
个人 + 少量用户完全够用。
