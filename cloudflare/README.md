# KayTV 云后台（Cloudflare Pages）

可选的云端控制台：管理影视源、直播源、TVBox 配置、公告和云账号。
三端不依赖它也能照常看片；配置后，源和公告会自动同步到 Windows、手机和 TV。

## 能力

- **源管理**：影视 CMS、直播 m3u/txt、TVBox 配置的增删改查、排序、启停、一键检测延迟与可用性。
- **公告**：标题 / 正文 / 级别 / 跳转链接 / 定时上下线，三端顶部横幅展示。
- **用户注册**：可关闭注册，可设置自动通过或人工审核；支持停用、恢复、删除。
- **云同步**：登录后的收藏和观看进度在三端合并（可选，不登录不影响看片）。
- **零服务器**：全部跑在 Cloudflare Pages + D1 免费额度内。

## 当前部署

- 地址：<https://kaytv-hub.pages.dev>（打开就是管理页）
- D1 数据库 `kaytv-hub`，绑定变量 `DB`
- 管理员口令只存在 Cloudflare Secret `ADMIN_TOKEN` 中，不在仓库里

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

> 只在 Cloudflare 控制台操作也可以：Workers & Pages → Create → Pages → 连接仓库或上传，
> 构建输出目录填 `admin`；在 D1 控制台粘贴 `schema.sql` 执行；
> 项目 Settings → Bindings 添加 D1，变量名必须是 `DB`；
> Settings → Variables and Secrets 添加 `ADMIN_TOKEN`，然后重新部署。

## 客户端接入

三端「设置 → 云后台」可查看连接状态；换成自己的部署时粘贴项目地址 → 保存并同步。
云源只在客户端内置模式（下载即用）下生效；连接 NAS 服务端时仍以 NAS 的源为准。

想让新安装的包自带默认地址：在 GitHub 仓库 Settings → Secrets and variables → Actions →
Variables 添加 `KAYTV_CLOUD_URL`，下次 release 构建会自动写入客户端。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 公开配置：公告 + 启用的源 + 注册开关 |
| POST | `/api/register` | 注册云账号 |
| POST | `/api/login` | 登录，返回 Bearer token |
| GET | `/api/me` | 当前账号 |
| GET/PUT | `/api/sync` | 拉取 / 推送收藏和观看进度 |
| GET | `/api/health` | 健康检查 |
| * | `/api/admin/*` | 管理接口，需 `Authorization: Bearer ADMIN_TOKEN` |

## 安全

- `ADMIN_TOKEN` 只放 Cloudflare Secrets，不要提交到仓库或前端构建。
- 用户密码使用 PBKDF2-SHA256（10 万次迭代 + 随机盐）存储，生产环境 Workers 的迭代上限。
- 管理接口与公共接口分离；写入接口限制字段长度和 URL 协议。
- 云同步单账号上限 512KB，防止滥用免费额度。

## 免费额度参考

D1 免费版每天 500 万行读、10 万行写；Pages 静态和 Functions 每天 10 万次请求。
个人 + 少量用户完全够用。
