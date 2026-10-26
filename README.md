# KayTV

聚合直播与点播的电视端影视应用：NAS 上跑一个服务端，电视 / 手机 / Windows 共用同一套源，网页端负责管理。

- **直播**：M3U / TXT 直播源（含饭太硬影视仓同款虎牙 / 斗鱼 / YY 直播），解析、去重、多线路与跨源自动切换，统一走签名代理
- **点播**：苹果 CMS v10 采集接口 + 看剧AI 官方线路，多源聚合搜索、分类浏览、海报墙、收藏与断点续播
- **内置可用**：桌面端与手机端内置全部源，打开即用，不连 NAS 也能搜索、看详情和播放
- **自动播放**：加载完成自动起播，默认就是有声播放（浏览器策略拦截时提示点一下画面，不会偷偷静音）
- **自动换源**：线路失效或卡住无画面时自动切线路、切片源，保持进度与集数
- **播放页**：手机竖屏是「上图下文」——16:9 画面 + 详情 / 线路 / 选集 / 猜你喜欢一屏滑到底；电脑与电视用同一套详情抽屉，横过来自动铺满
- **音量同步**：手机与电视端直接读写系统媒体音量，机身音量键和播放器音量条是同一个值
- **投屏**：拉起系统无线显示 / 多屏互动面板，选中电视即可镜像播放（手机端）
- **本地缓存**：分类、片墙、详情首次打开后落盘，之后启动直接铺旧数据再后台刷新，不用每次等加载
- **播放器控制**：倍速 0.5–3x、跳过片头/片尾（自动接下一集）、画面适应/铺满、音轨字幕切换、播放源抽屉
- **真全屏**：手机端全屏会隐藏状态栏与导航栏并转横屏，退出播放自动恢复；电视与桌面走各自原生全屏
- **自定义选源**：播放中可直接指定任意已启用片源，用当前片名在该源内检索并接管进度，不再只能被动等自动换源
- **自动分类**：电影 / 电视剧 / 综艺 / 红果短剧 / 动漫 / 纪录片，片源筛选随分类切换，底部按中国、美国、日韩、港台等地区筛选
- **自动维护**：每天 04:10 自动同步 TVBox 订阅、检测源可用性，失败源 24 小时内自动跳过
- **多用户**：后台可创建管理员 / 普通用户，观看模式可设为「公开」或「登录观看」
- **电视优先**：遥控器方向键空间导航、全屏播放器、选集抽屉、大字号海报墙
- **源管理**：网页后台增删启停直播 / 影视源，测试连通性，导入导出配置
- **客户端**：Windows 安装包 / 免安装版、Android 手机 APK、Android TV APK、NAS 网页版

## 下载即用

三个客户端都是独立完整的，下载安装后直接打开就能搜索和播放，不需要服务器、不需要配置、不需要注册：

| 设备 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11 | `KayTV-<版本>-windows-setup.exe` | 安装包，自动创建快捷方式 |
| Windows 免安装 | `KayTV-<版本>-windows-portable.exe` | 单个 exe，拷到哪跑到哪 |
| 安卓手机 / 平板 | `KayTV-<版本>-phone.apk` | 允许横竖屏，支持后台返回与常亮 |
| 安卓电视 / 盒子 | `KayTV-<版本>-tv.apk` | Leanback 启动器、遥控器焦点、锁横屏 |

固定直链（永远指向最新版）：

```
https://github.com/kaynai1/kaytv/releases/latest/download/KayTV-0.4.0-windows-setup.exe
```

版本号会变，所以更省事的做法是直接打开 <https://github.com/kaynai1/kaytv/releases/latest> 选自己那台设备的文件。应用内 **设置 → 版本更新** 会显示二维码，手机扫码即可打开这个页面，电视端也能用浏览器直接下载。

Windows 首次运行可能弹 SmartScreen，点「更多信息 → 仍要运行」；安卓需要允许「安装未知来源应用」。

## 1. NAS 部署

仓库根目录的 `docker-compose.yml` 直接使用预构建镜像：

```bash
docker compose up -d
```

默认监听 `8080`，数据保存在 `./data`。首次启动若未设置密码，会在日志中打印随机管理密码：

```bash
docker logs kaytv
```

推荐在 `.env` 或 compose 中固定密码：

```bash
ADMIN_PASSWORD=你的管理密码 docker compose up -d
```

服务端模式要用「看剧AI」源时再补一个密钥（不填只影响这一个源）：

```bash
ADMIN_PASSWORD=你的管理密码 KANJU_SECRET=接口密钥 docker compose up -d
```

管理后台：`http://NAS地址:8080/admin`

> 8080 被占用时，把 compose 的端口改成 `8090:8080` 即可，容器内部端口不用动。

### 从源码构建镜像

```bash
docker build -t kaytv:local .
# 然后注释 compose 里的 image，取消 build: . 的注释
docker compose up -d --build
```

## 2. 添加源

进入 `/admin` 后：

- **直播源**：填 M3U / TXT 列表地址，支持自动识别格式与自定义请求头。保存前可点「测试连通」查看频道数和分组。
- **影视源**：选择接口类型后填写地址。苹果 CMS v10 填 `https://example.com/api.php/provide/vod`；看剧AI 填站点根地址 `https://kanju78.com`，详情页会列出站点线路（官方线路优先并标注「官方」），失效时自动切换下一条。保存前都能「测试连通」。
- **源检测**：查看全部源的健康状态、延迟与分类数，可随时「立即检测全部」；每天 04:10 也会自动检测。
- **订阅同步**：添加 TVBox 配置 / 资源合集 / 采集接口数组，每天自动抽取可直连的苹果 CMS 源；「预览」可先看能导入多少源。
- **用户**：创建管理员或普通用户，可停用、重置密码、删除；把「站点设置 → 访问控制」切到「登录观看」后，只有登录账号才能播放。
- **站点设置**：修改站点名称、访问模式、每日自动更新开关和管理密码。
- **接入与备份**：导出 / 导入 JSON 源配置，查看客户端应填写的服务地址。

保存后客户端在「设置 → 同步源列表」即可拉到最新配置；正在播放的页面刷新后生效。

### 分类与自动更新

影视页按「电影 / 电视剧 / 综艺 / 红果短剧 / 动漫 / 纪录片」聚合所有已启用源，并可再按中国、美国、日韩、港台、台湾等地区筛选。短剧与综艺分类来自各源自身的分类名，不需要手工维护片单。

每天 04:10 服务端会先同步订阅、再检测全部源；检测失败的源会在 24 小时内暂时从分类、搜索和海报墙中排除，避免拖慢加载。想改时间可设置环境变量 `AUTO_CHECK_HOUR` / `AUTO_CHECK_MINUTE`（24 小时制）。

部分采集接口在特定网络下（DNS 污染、校园网、海外线路）需要代理才能访问。服务端支持统一出站代理：设置环境变量 `OUTBOUND_PROXY=http://127.0.0.1:7897` 后重启，直播、点播、订阅同步和源检测都会走该代理；留空则直连。Docker 部署可打开 `docker-compose.yml` 中对应的注释。

## 3. 客户端连接

Windows 安装包 / 免安装版、Android 端和网页版都内置默认源，**打开即用**：搜索、分类、详情、播放全部在客户端本地完成，不依赖 NAS，也不需要注册。

NAS 只在需要这些能力时才要连接：管理后台、多用户登录、统一签名代理、订阅同步与每日源检测。

### 云后台（可选，无需服务器）

想自己加源、发公告、管注册用户，又不想开 NAS，可以用随附的 Cloudflare Pages 云后台：

- 地址：<https://kaytv-hub.pages.dev>（打开就是管理页，输入管理员口令登录）
- 可管理影视源、直播源、TVBox 配置、公告和注册用户；保存后三端自动同步
- 三端默认已内置该地址，不需要任何配置；在「设置 → 云后台」可查看状态或换成自己的部署
- 云账号登录可选，用于在三端合并收藏和观看进度；不登录不影响看片

部署自己的云后台见 [`cloudflare/README.md`](cloudflare/README.md)，全部跑在 Cloudflare 免费额度内。

1. 打开客户端「设置」
2. 服务端地址填 `http://NAS地址:8080`（也可以带端口映射后的地址）
3. 点「测试并保存」

也可以用 `?server=http://NAS地址:8080` 打开网页版，自动写入地址。

### Android TV / 盒子

从 GitHub Releases 下载 `KayTV-TV-*-debug.apk`，然后：

```bash
adb connect 电视IP:5555
adb install -r KayTV-TV-*-debug.apk
```

电视端要求 Android 7.0（API 24）及以上。已声明 Leanback 启动入口，会出现在电视应用列表中；界面固定横屏。

### Windows

Releases 中提供两种形式：

- `KayTV-Setup-*.exe`：安装版，可选安装目录
- `KayTV-*-portable.exe`：免安装单文件

已适配遥控器 / 键盘方向键，`F11` 切换全屏。

## 4. 遥控器 / 键盘操作

| 操作 | 按键 |
| --- | --- |
| 移动焦点 | 方向键 |
| 确认 / 播放暂停 | Enter / OK |
| 快退 / 快进 15 秒 | ← / → |
| 打开选集或频道列表 | ↑ |
| 退出播放 / 返回 | Esc / Backspace / 遥控器返回 |

## 5. 本地开发

需要 Node.js 22+：

```bash
npm install
npm run dev
```

- 前端：`http://localhost:5173`（`/api` 代理到 8080）
- 服务端：`http://localhost:8080`
- 管理密码可用 `ADMIN_PASSWORD=test1234 npm run dev:server` 固定
- 8080 本机端口被其他软件占用时，可指定代理目标：`VITE_API_TARGET=http://NAS地址:8080 npm run dev:web`

单独构建与启动：

```bash
npm run build
npm start
```

### 构建期密钥

仓库不再包含任何密钥，两个可选密钥全部由构建期注入。缺失时应用照常工作，只是对应能力降级：

| 变量 | 作用 | 不设置时 |
| --- | --- | --- |
| `VITE_TMDB_API_KEY` | 海报墙背景图与高清海报（TMDB v3） | 回落到片源自带封面 |
| `VITE_KANJU_SECRET` | 内置模式下签「看剧AI」接口请求 | 该源报错跳过，其余内置源不受影响 |
| `KANJU_SECRET` | NAS 服务端模式下签同一个接口 | 看剧AI 源返回 503 |

本地写在 `web/.env`（已被 `.gitignore` 忽略），照抄 `web/.env.example` 即可：

```bash
cp web/.env.example web/.env   # 然后填入自己的密钥
```

GitHub Actions 用仓库 Secrets 注入：`TMDB_API_KEY`、`KANJU_SECRET`，另外 APK 正式签名需要 `KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD` 四项。

## 6. 打包与发布

推送到 GitHub 后：

- `.github/workflows/docker.yml`：在 `main` 分支或 `v*` 标签构建并推送 `ghcr.io/<owner>/kaytv`
- `.github/workflows/release.yml`：在 `v*` 标签构建 **Windows 安装包 / 免安装版 + 手机 APK + 电视 APK** 四个产物，签名后上传到 GitHub Release，并附 `SHA256SUMS.txt`
- `.github/workflows/ci.yml`：PR / main 的前端类型检查与构建

```bash
git tag v0.4.0
git push origin v0.4.0
```

产物命名固定为 `KayTV-<版本>-windows-setup.exe` / `-windows-portable.exe` / `-phone.apk` / `-tv.apk`，配合 `releases/latest/download/...` 可以做成不随版本变化的取货直链。

首次推送后，到 GitHub 仓库的 **Packages** 设置里把 `kaytv` 镜像可见性改为 **Public**，否则 fnOS / 群晖等 NAS 未登录 GHCR 时无法拉取。

本地打包（Windows 打包在 Windows 上执行；APK 需要 JDK 21 + Android SDK 36，建议直接交给 Actions）：

```bash
# Windows
cd desktop
npm install
npm run dist

# Android：同一份工程按设备形态各打一次包
cd mobile
npm install
npm run sync
node patch-android.mjs --device=phone
cd android && ./gradlew assembleRelease
# 产物 mobile/android/app/build/outputs/apk/release/app-release.apk
cd ../.. && node patch-android.mjs --device=tv
cd android && ./gradlew assembleRelease
```

图标与闪屏由 `mobile/resources/icon.png` 派生，改动后重新生成：

```bash
cd mobile
npm i -D sharp @capacitor/assets
node make-assets.mjs                        # 圆角主图标 / 闪屏 / TV banner
npx @capacitor/assets generate --android    # 分发到各密度 mipmap 与 splash
```

打包说明：

- Windows 端使用 Electron，前端以单文件模式内联，离线加载不会有跨域问题
- Android 端使用 Capacitor：`phone` 形态跟随重力旋转、要求触屏；`tv` 形态锁横屏、放开触屏要求、补 Leanback 入口与 TV banner。两个包 `applicationId` 相同（`com.kaynai.kaytv`），一台设备只能装其中一个，按设备下载对应文件即可
- 未配置签名 Secrets 时 APK 会退回 debug 签名，能侧载但覆盖安装正式签名版本会失败，务必固定同一份 keystore
- 下载后首次运行：Windows 可能触发 SmartScreen，点「更多信息 → 仍要运行」；Android 需允许「安装未知来源应用」

## 7. 数据与备份

容器内 `/data` 保存：

- `config.json`：站点名称、访问模式、全部源与订阅配置
- `admin.json`：管理密码哈希
- `users.json`：观看账号（用户名、角色、密码哈希）
- `source-status.json`：最近一次源检测结果与下次检测时间

备份 `./data` 目录即可迁移；删除 `admin.json` 并重启可重新生成初始密码（设置了 `ADMIN_PASSWORD` 时以环境变量为准）。

## 8. 说明

KayTV 只做播放与聚合，不存储、不转卖任何影视内容。直播列表与采集接口均来自公开网络，可用性取决于上游站点。请遵守当地法律法规与源站使用条款。
