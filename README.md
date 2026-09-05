# WorkBuddy for Linux (Unofficial)

[English](#english) | [简体中文](#简体中文)

---

# 简体中文

## 项目简介

这是一款非官方社区工具，核心作用是将你自行获取的官方 WorkBuddy macOS Intel/x64 版本 DMG 安装包，转换为可在本地 Linux 系统运行的 Electron 应用。

本仓库**仅作为转换工具**，绝不充当软件分发渠道。请务必前往官方网站下载正版 Intel/x64 架构 DMG 安装包，放置于项目 `downloads/` 目录下；所有生成的应用目录、安装包产物均仅保留在本地，且已加入 Git 忽略规则，不会被提交至仓库。

遇到任何 Bug 请在此仓库提 Issue ，严禁跳脸向官方客服反馈在 Linux 移植后使用的相关问题。

## 项目状态

目前项目已完整实现 Linux 端的转换与打包核心流程，具体功能如下：

- 借助 `7z`/`7zz` 工具，自动提取 `downloads/` 目录下唯一的官方 DMG 安装包；
- 从 macOS 应用包元数据中，自动识别上游 Electron 版本号；
- 下载与识别版本匹配的 Linux 版 Electron 运行时；
- 将 WorkBuddy 应用核心程序（`app.asar` 及 `app.asar.unpacked`）复制至 `resources/` 目录；
- 通过 `@electron/rebuild`，针对 Linux 系统与 Electron 环境重建原生 Node 模块；
- 安装 `@lydell/node-pty` Linux 平台预编译包以支持内置 CLI；
- 更新适配 Linux 平台的依赖包，例如 `@vscode/ripgrep`；
- 自动生成 Linux 系统启动器与桌面入口文件；
- 根据当前 Linux 发行版，一键生成适配的 `.deb`、`.rpm` 或 `.pkg.tar.zst` 格式安装包。

> 项目**未集成自动更新功能**，如需更新软件，只需手动下载新版官方 DMG，放入 `downloads/` 目录后，重新执行构建、安装流程即可覆盖本地旧版本。

## 快速安装

本项目**未上架 AUR**，所有 Linux 发行版均需在本地通过本仓库脚本完成构建与安装。

1. 克隆本项目至本地 Linux 机器；
2. 在项目根目录创建 `downloads` 文件夹；
3. 自行从官方渠道下载 Intel/x64 架构 DMG 安装包，放入 `downloads/` 目录（仅放**唯一一份**）；
4. 依次执行：

```bash
bash scripts/install-deps.sh
make build-app
make package
make install
```

`scripts/install-deps.sh` 会自动识别当前系统的包管理器（支持 `apt`、`dnf5`、`dnf`、`pacman`、`zypper`），一键安装 DMG 提取、Electron 运行时下载、原生模块重建、安装包生成所需的全部依赖。

> 测试范围：已在 Debian 系（Linux Mint 22.3）和 Arch 系（CachyOS）完成完整打包部署实测，运行稳定。

## 构建与运行

### 推荐构建方式

将官方 DMG 文件放入 `downloads/` 目录后，直接执行：

```bash
make build-app
```

### 自定义 DMG 路径

也可手动指定官方 DMG 文件路径：

```bash
make build-app DMG=/path/to/WorkBuddy.dmg
```

### 运行生成的应用

```bash
make run-app
```

### 打包并安装

自动生成适配当前发行版的安装包（`.deb`、`.rpm`、`.pkg.tar.zst`）或便携 AppImage，并完成本地安装：

```bash
make package
make install
```

也可以指定格式：
```bash
make deb          # Debian/Ubuntu (.deb)
make rpm          # Fedora/RHEL (.rpm)
make pacman       # Arch Linux (.pkg.tar.zst)
make appimage     # 便携 AppImage（自动下载 appimagetool）
# 或通过环境变量指定：
PACKAGE_FORMAT=appimage make package
```

## 实现原理

本项目参考了 `codebuddy-ide-cn-linux`（同作者的成功移植案例）的本地转换与打包逻辑，但**未移植自动更新模块**，核心流程如下：

1. 以用户自行提供的官方 macOS DMG 安装包作为输入源；
2. 仅提取 Electron 应用核心程序，不对外分发任何官方软件内容；
3. 用对应版本的 Linux Electron 运行时，替换原 macOS 版运行时；
4. **原生模块从源码重新编译**：macOS DMG 预打包的原生模块（如 `node-pty`、`better-sqlite3`）无法在 Linux 上直接使用。本工具自动从 npm 下载对应版本的完整源码，在隔离目录基于 Linux Electron 头文件重新编译为 ELF 二进制文件，再覆盖回应用目录；
5. 安装 Linux 平台专属的预编译包（如 `@lydell/node-pty-linux-x64`）以支持内置终端 CLI；
6. 更新适配 Linux 平台的专属二进制依赖包；
7. 本地生成 Linux 系统启动配置与安装包元数据；
8. 编译生成对应发行版的原生安装包，通过 `make install` 完成最新版本安装。

WorkBuddy 基于 VS Code/Electron 开发，其 macOS 应用的 `app.asar` 文件包含跨平台 JavaScript 核心代码，`app.asar.unpacked` 目录包含原生模块。Linux 转换只需完成平台二进制文件替换、原生模块重新编译即可实现兼容。

## 移植后的已知限制

由于上游打包特性的限制以及闭源商业组件的存在，移植后的 Linux 版本存在以下预期内的功能降级（不影响核心开发体验）：

1. **腾讯文档引擎**：官方 DMG 包内捆绑的 `@tencent/docs-engine` 仅提供了 macOS Arm64 架构的专有二进制库（`.dylib`）。Linux 无法运行此类文件且无源码可供重新编译，为防止底层引发 `dlopen invalid ELF header` 导致的主进程崩溃，转换脚本已将其强制移除。**当前状态**：经测试，**腾讯文档的基本创建、读取、修改功能均正常可用**（通过云 API 通道），不影响 AI 助手和本地代码编辑。深度协同编辑、复杂文档渲染等依赖原生 docs-engine 的能力无法使用。
2. **AI 代码沙盒降级**：内置 CLI 工具 `vendor/sandbox` 是腾讯内部私有的代码沙盒引擎（Tencent Sandbox），使用的是包含 Windows 和 macOS 格式的预编译隔离库。由于缺少 Linux 版沙盒核心，脚本已清理无关平台的二进制文件。**影响**：当 AI 助手尝试全自动执行代码时，会因为沙盒模块缺失而回退到无沙盒的真实终端中执行，或者提示安全环境不可用而拒绝执行自动化脚本。
3. **自动更新不可用**：Linux 移植版已禁用应用内的"检查更新"功能（菜单项灰化、后台自动检查已关闭）。上游更新器依赖 macOS ShipIt / Windows Squirrel 安装器，在 Linux 上无法使用。如需更新，请手动下载新版官方 DMG 并重新执行构建流程。
## 移植过程中已修复的问题

以下问题在移植过程中已通过 Linux 运行时补丁（`scripts/lib/apply-linux-patches.js`）修复：

1. **主窗口无法弹出（E2BIG）**：上游代码将 ~260KB 的产品配置 JSON 写入 `process.env.ACC_PRODUCT_CONFIG_V3`，超过 Linux `MAX_ARG_STRLEN`（128KB/条）限制，导致 Chromium 网络服务/GPU/Utility 子进程全部 spawn 失败，渲染进程无法启动。**修复方式**：用 Proxy 替换 `process.env`，将超大 key 隐藏在 JS 私有 slot 中，libc environ 保持小体积。
2. **托盘右键菜单为空**：Linux 的 AppIndicator 后端不触发 `click`/`right-click` 事件，只显示通过 `tray.setContextMenu()` 附加的菜单。**修复方式**：在 Linux 下额外调用 `this.tray.setContextMenu(contextMenu)`。
3. **托盘图标显示为感叹号**：上游把图片 resize 成内存 NativeImage 传给 Tray，AppIndicator 无法正确渲染。**修复方式**：Linux 下直接用磁盘上的 `.workbuddy-linux/workbuddy.png` 路径构造 Tray。
4. **Sidecar 子进程 spawn 失败（E2BIG）**：`buildCliEnv()` 显式把 260KB 字符串塞进 spawn 的 env 对象。**修复方式**：Monkey-patch `child_process.spawn/spawnSync`，超过 100KB 的 env 条目自动 spill 到临时文件，子进程启动时从文件读回并通过 Proxy 恢复。
5. **`@lydell/node-pty-linux-x64` 找不到**：原 macOS asar 里只有 darwin 平台包。**修复方式**：repack 时将 Linux 平台包注入 asar 并标记为 unpacked。
6. **首条聊天 / 连接器永远 connecting（5.0.3+wb3）**：上游 `BinaryManager.doInitialize()` 在 Linux 偶发永远 pending、`child_process.exec()` 自带 `timeout` 选项对 hang 在 syscall 里的子进程不生效（已实测 `which 'tcb'` 80s+ 不返回），同时 `userPromptComposer / runtimeConfigResolver` 在首次启动时也会卡在远端 RPC 上。任一环节卡住都会让 stdio MCP server 启动等到上游 122s connect timeout、或让首条聊天消息无限等待。**修复方式**：在 `apply-linux-patches.js` 的 Patch 7A-7F 给 `prepareNodeRuntimeEnv` / `composePromptForBackend` / `resolveRuntimeConfig` / `runPreCliAuth` / `isCliInstalled` 等关键 await 点统一加 `Promise.race` 兜底（5s/6s/30s 不等），超时回退到继承 PATH、原始 prompt、fallback config 或跳过 preAuth，**不阻塞 UI 线程**。所有 race 都标 `markOptional`，单个 anchor 失配不影响其它 patch。
7. **Wayland / 现代面板下托盘图标完全不显示（5.0.3+wb3）**：Electron 默认仍走 GtkStatusIcon (X11 XEmbed)，但 Wayland session 与 waybar、quickshell DMS、KDE Plasma 6 等只实现 StatusNotifierItem (KDE SNI)，XEmbed 完全失效，应用日志虽然写 `trayActive=true, hasIcon=true`，但实际没在 SNI 上注册。**修复方式**：`install.sh` 生成的 `start.sh` 模板里把 `Unity` 注入到 `XDG_CURRENT_DESKTOP`（如 `Unity:XFCE`），让 Electron 走 `ayatana-appindicator` (SNI) 路径；保留原桌面名以兼容其它依赖该变量的程序。
8. **多 connector 启用时首条 LLM 调用阻塞分钟级（5.0.3+wb3）**：上游 codebuddy CLI 的 stdio MCP settle 默认 30s/server 串行等待。**修复方式**：`start.sh` 默认 `MCP_TIMEOUT=3000`，配合 codebuddy.js 内部的 `cliMcpSettleTimeoutInteractive` patch；健康服务正常使用，慢服务跳过。
9. **WorkBuddy App / 小程序远程控制重启后需要手动开关**：上游 `ClawLifecycle.start()` 启动时会恢复已保存通道并启动 Centrifugo，但微信/小程序集成的 `wechatmp` 默认启用状态可能只停留在本地配置，后台注册和远程订阅没有在桌面端重启后完整重放。**修复方式**：Linux 运行时补丁在 Claw 生命周期启动后延迟重放已启用的 `wechatmp` 集成，重新写入启用状态、调用后台注册并启动 Centrifugo，避免关闭再打开程序后必须手动关闭/打开「微信/小程序集成」开关。
10. **子进程环境变量丢失导致模型无法响应（5.1.1）**：Env Proxy 的 `ownKeys` 不返回 `ACC_PRODUCT_CONFIG_V3`，`spillOversizedEnv()` 通过 `Object.assign({}, env)` 拷贝时遗漏了隐藏 key，非 oversized（<100KB）时直接返回原 Proxy 对象，子进程始终拿不到该环境变量。**修复方式**：始终构建普通对象拷贝 env，显式将隐藏的 `ACC_PRODUCT_CONFIG_V3/V2` 添加到子进程 env 中，超过 100KB 的仍 spill 到文件。
11. **`composePromptForBackend` 锚点未适配 5.1.1 代码结构**：上游 5.x 将 `composeUserPrompt` 的参数从 `cloneDesiredConfig(session.desiredConfig)` 改为 `session.desiredConfig`，导致补丁的字符串锚点匹配失败，`composePromptForBackendTimeout` 补丁被跳过，首条聊天消息可能卡死在 prompt 合成阶段。**修复方式**：将匹配模式更新为 `session.desiredConfig`，同时保留 5s `Promise.race` 超时 + 原始 prompt 回退逻辑。

## 版本适配说明

当前补丁基于官方 WorkBuddy **4.22.10**（构建号 `27634624-ec5e02bd`）、**5.0.3**（构建号 `30150715-f5a1d06d`）和 **5.1.1**（构建号 `30799983-ecafd59f`）验证通过。5.x 使用 Electron 37.10.3，仍采用 `app.asar` + `app.asar.unpacked` 载荷结构。更高版本的 DMG 可能因为上游代码结构变化导致补丁无法正确应用；构建脚本会在必需补丁未命中时中止，并在成功时生成 `.workbuddy-linux/patch-report.json` 记录补丁命中结果。如遇到构建失败或运行异常，请在本仓库提 Issue 并附上所使用的 DMG 版本号。

Linux 启动脚本默认启用 Chromium sandbox。只有在明确理解安全风险并需要临时排障时，才使用下面的方式降级启动：

```bash
WORKBUDDY_DISABLE_SANDBOX=1 workbuddy --verbose
```

## 常用自定义配置

如需自定义安装路径、切换 Electron 镜像，可通过以下命令执行：

```bash
# 自定义安装目录
WORKBUDDY_INSTALL_DIR=/opt/tmp/workbuddy-app bash install.sh
# 切换Electron镜像源
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bash install.sh
# 自定义Electron头文件下载地址
ELECTRON_HEADERS_URL=https://artifacts.electronjs.org/headers/dist bash install.sh
```

打包阶段（如 `make deb` / `make rpm` / `make pacman`）的元数据也可通过环境变量覆盖：

```bash
# 自定义 deb / rpm / pacman 包中的 Maintainer 字段
# deb 和 pacman 接受完整的 "Name <email>" 字符串
MAINTAINER="LeisureLinux <AlbertXu@FreeLAMP.com>" make deb
# rpm 将空格前的部分作为 Name 提交为 packager
MAINTAINER_NAME="LeisureLinux" make rpm

# 自定义 deb / rpm / pacman 包中的 Homepage / URL / url 字段
# 同时影响 control 文件的 Homepage: 行和描述中的下载页链接
HOMEPAGE="https://workbuddy.cn/" make deb
```

未设置时使用以下默认值，与当前 `packaging/linux/control` 模板保持一致：

- `MAINTAINER` / `MAINTAINER_NAME` → `LeisureLinux <AlbertXu@FreeLAMP.com>` / `LeisureLinux`
- `HOMEPAGE` → `https://workbuddy.cn/`

## 仓库维护规范

以下目录因会存放上游软件、生成类安装包文件，已被 Git 忽略，**切勿手动提交**：

- `downloads/`
- `build/`
- `workbuddy-app/`
- `dist/`
- `reference/`

禁止提交 DMG 安装包、解压后的 `.app` 应用包、生成的 Linux 应用目录及各类原生安装包产物。

## 免责声明

本项目为**非官方社区开源工具**，与腾讯官方无任何关联。WorkBuddy 是腾讯旗下产品（版权 © 2026 腾讯云计算（北京）有限责任公司丨腾讯科技（深圳）有限公司 版权所有）。本工具不分发任何 WorkBuddy 官方软件，仅自动化实现用户对自有正版安装包的格式转换流程。

使用本工具产生的 WorkBuddy 应用仍受腾讯官方协议约束，请以官网或应用内最新版服务条款、隐私协议为准。

使用本工具即表示您已知悉并同意以下内容：

1. **用户责任**：您有责任确保自行获取的 DMG 安装包来源合法，并遵守 WorkBuddy 的最终用户许可协议（EULA）及相关服务条款。
2. **无担保**：本工具按"现状"提供，不提供任何形式的明示或暗示担保，包括但不限于对适销性、特定用途适用性和非侵权性的担保。
3. **无官方支持**：本项目是独立社区项目，腾讯官方不对本工具提供任何技术支持。在 Linux 移植环境下遇到的问题，请在本仓库提 Issue，**严禁向官方客服反馈**。
4. **风险自担**：使用本工具进行格式转换和运行所产生的一切后果，由用户自行承担。
5. **商标声明**：WorkBuddy、CodeBuddy 及相关标识是腾讯公司的商标或注册商标。本项目使用这些名称仅用于描述性目的，不暗示任何官方认可或授权。
6. **下架预案**：如腾讯或任何相关权利方对本项目存在异议，请通过本仓库 Issue 或邮件联系维护者。维护者承诺在收到合理异议后立即停止维护，并按权利方要求处理 GitHub 仓库。
7. **项目定位**： 本项目（包括本 GitHub 仓库及相关自动化脚本）仅用于技术研究与概念验证。原作者从未、亦绝不分发任何官方二进制软件。
8. **第三方责任**： 任何第三方因 Fork、修改本项目，或自行分发移植二进制安装包（Releases）而产生的版权争议与法律责任，均由该第三方独立承担，与本项目原作者无关。

## 开源许可证

本项目（转换脚本及相关 recipe）采用 MIT 开源许可证，详细内容请查看 [LICENSE](LICENSE) 文件。MIT 许可仅覆盖本仓库中的转换工具，**不延伸到通过本工具安装的腾讯 WorkBuddy 二进制文件**——后者仍受腾讯官方私有协议约束。

---

# English

## Project Introduction

This is an unofficial community tool designed to convert your legally obtained official WorkBuddy macOS Intel/x64 DMG installer into a local Linux Electron application.

This repository **serves solely as a converter** and will never act as a software redistribution channel. Please download the genuine Intel/x64 DMG installer from the official website and place it in the `downloads/` directory. All generated application directories and package artifacts are stored locally only and are added to Git ignore rules to avoid being committed to the repository.

If you encounter any bugs, please submit an Issue in this repository. Do not directly contact official customer service to report issues related to usage after Linux porting.

## Project Status

The project currently fully implements the core Linux-side conversion and packaging workflow, with specific features as follows:

- Automatically extract the single official DMG installer in the `downloads/` directory via `7z`/`7zz`;
- Detect the upstream Electron version from the macOS application bundle metadata;
- Download the matching Linux Electron runtime corresponding to the detected version;
- Copy the core WorkBuddy application payload (`app.asar` and `app.asar.unpacked`) to the `resources/` directory;
- Rebuild native Node modules for Linux system and Electron environment using `@electron/rebuild`;
- Install `@lydell/node-pty` Linux platform prebuilt packages to support the built-in CLI;
- Update Linux platform-adapted dependencies such as `@vscode/ripgrep`;
- Automatically generate Linux system launcher and desktop entry files;
- Generate compatible `.deb`, `.rpm` or `.pkg.tar.zst` packages based on the current Linux distribution.

> No auto-update feature is integrated in this project. To update the software, simply manually download the latest official DMG, place it in the `downloads/` directory, and re-run the build and installation process to overwrite the old version.

## Quick Install

This project is **not published on the AUR**. All Linux distributions must build and install locally via the scripts in this repository.

1. Clone this repository to your local Linux machine;
2. Create a `downloads/` folder in the project root;
3. Download the official Intel/x64 DMG installer yourself and place it in `downloads/` (place **exactly one** DMG);
4. Run:

```bash
bash scripts/install-deps.sh
make build-app
make package
make install
```

`scripts/install-deps.sh` automatically detects the package manager (`apt`, `dnf5`, `dnf`, `pacman`, `zypper`) and installs all dependencies needed for DMG extraction, Electron runtime download, native module rebuilding and package generation.

> Testing scope: fully tested on Debian-based (Linux Mint 22.3) and Arch-based (CachyOS) systems.

## Build & Run

### Recommended Build Method

Place the official DMG in `downloads/` and run:

```bash
make build-app
```

### Custom DMG Path

You can also manually specify the path of the official DMG file:

```bash
make build-app DMG=/path/to/WorkBuddy.dmg
```

### Run the Generated Application

```bash
make run-app
```

### Package & Install

Generate a distribution-compatible package (`.deb`, `.rpm`, `.pkg.tar.zst`) or a portable
AppImage, then install it locally:

```bash
make package
make install
```

You can also build a specific format:
```bash
make deb          # Debian/Ubuntu (.deb)
make rpm          # Fedora/RHEL (.rpm)
make pacman       # Arch Linux (.pkg.tar.zst)
make appimage     # portable AppImage (auto-downloads appimagetool)
# or via environment variable:
PACKAGE_FORMAT=appimage make package
```

## How It Works

This project references the local conversion and packaging logic of `codebuddy-ide-cn-linux` (a successful porting case by the same author), but **does not port its auto-update module**. The core workflow is as follows:

1. Take the official macOS DMG installer provided by the user as the input source;
2. Only extract the core Electron application payload without redistributing any official software content;
3. Replace the original macOS Electron runtime with the corresponding Linux Electron runtime;
4. **Recompile Native Modules from Source**: Pre-packaged native modules (e.g., `node-pty`, `better-sqlite3`) in the macOS DMG cannot be used directly on Linux. This tool automatically downloads full source from npm for the exact versions needed, recompiles them into Linux ELF binaries against the Linux Electron headers in an isolated directory, and replaces the original modules;
5. Install Linux platform-specific prebuilt packages (e.g., `@lydell/node-pty-linux-x64`) to support the built-in terminal CLI;
6. Update platform-specific binary dependencies adapted for Linux;
7. Generate Linux system startup configuration and package metadata locally;
8. Compile a native package for the current distribution and install the latest version via `make install`.

WorkBuddy is developed based on VS Code/Electron. Its macOS application's `app.asar` file contains the cross-platform JavaScript core code, while the `app.asar.unpacked` directory contains native modules. Linux compatibility can be achieved by replacing platform binaries and recompiling native modules.

## Known Limitations after Porting

Due to upstream packaging characteristics and the presence of closed-source commercial components, the ported Linux version has the following expected functional degradations (which do not affect the core development experience):

1. **Tencent Docs Engine Pending Further Testing**: The bundled `@tencent/docs-engine` in the official DMG only provides a proprietary binary library (`.dylib`) for the macOS Arm64 architecture. Linux cannot run such files and there is no source code available for recompilation. To prevent the main process from crashing due to underlying `dlopen invalid ELF header` errors, the conversion script has forcibly removed it. **Current status**: Login and Tencent Docs list/content retrieval have been confirmed to work; deep collaborative editing, complex document rendering, or features depending on the native docs-engine still need further testing. This does not affect the AI assistant or local code editing.
2. **AI Code Sandbox Degradation**: The built-in CLI tool `vendor/sandbox` is Tencent's proprietary code isolation engine (Tencent Sandbox), which uses precompiled isolation libraries formatted for Windows and macOS. Lacking a Linux sandbox core, the script has cleaned up these irrelevant platform binaries. **Impact**: When the AI assistant attempts to automatically execute code, it will either fall back to executing in a real terminal without a sandbox due to the missing sandbox module, or it will refuse to execute automated scripts, prompting that a secure environment is unavailable.
3. **Auto-Update Disabled**: The Linux port has disabled the in-app "Check for Updates" feature (menu item greyed out, background auto-check disabled). The upstream updater relies on macOS ShipIt / Windows Squirrel installers which are not available on Linux. To update, manually download the latest official DMG and re-run the build process.
## Issues Fixed During Porting

The following issues have been resolved via Linux runtime patches (`scripts/lib/apply-linux-patches.js`):

1. **Main window fails to appear (E2BIG)**: Upstream writes a ~260KB product configuration JSON into `process.env.ACC_PRODUCT_CONFIG_V3`, exceeding Linux's `MAX_ARG_STRLEN` (128KB per env string) limit, causing all Chromium network/GPU/utility subprocess spawns to fail and preventing the renderer from starting. **Fix**: Replace `process.env` with a Proxy that keeps oversized keys in a private JS slot, hidden from enumeration.
2. **Tray right-click menu is empty**: Linux's AppIndicator backend never emits `click`/`right-click` events and only displays menus attached via `tray.setContextMenu()`. **Fix**: Call `this.tray.setContextMenu(contextMenu)` on Linux.
3. **Tray icon shows as exclamation mark**: Upstream passes a resized in-memory NativeImage to Tray, which AppIndicator cannot render. **Fix**: On Linux, construct the Tray from the on-disk `.workbuddy-linux/workbuddy.png` path.
4. **Sidecar subprocess spawn fails (E2BIG)**: `buildCliEnv()` explicitly puts the 260KB string into the spawn env object. **Fix**: Monkey-patch `child_process.spawn/spawnSync` to spill env entries >100KB to temp files; child processes restore the value from file on startup.
5. **`@lydell/node-pty-linux-x64` not found**: The original macOS asar only contains darwin platform packages. **Fix**: Inject the Linux platform package into the asar during repack and mark it as unpacked.
6. **First chat / connectors stuck "connecting" forever (5.0.3+wb3)**: Upstream's `BinaryManager.doInitialize()` occasionally stays pending forever on Linux; `child_process.exec()`'s `timeout` option does not always fire for children stuck in syscalls (we measured `which 'tcb'` not returning for 80s+); and `userPromptComposer / runtimeConfigResolver` block on remote RPCs that haven't booted yet on first launch. Any one of those wedges the stdio MCP startup until the upstream 122s connect timeout, or hangs the very first chat message indefinitely. **Fix**: Patches 7A-7F in `apply-linux-patches.js` wrap `prepareNodeRuntimeEnv` / `composePromptForBackend` / `resolveRuntimeConfig` / `runPreCliAuth` / `isCliInstalled` with `Promise.race` fallbacks (5s / 6s / 30s depending on the path). On timeout we fall back to inherited PATH, the raw prompt, the fallback config, or skip preAuth — **the UI thread is never blocked**. Each race is `markOptional`, so a single anchor mismatch on a future upstream release won't take the rest of the patches down with it.
7. **Tray icon completely missing on Wayland / modern panels (5.0.3+wb3)**: Electron defaults to `GtkStatusIcon` (X11 XEmbed), but Wayland sessions and panels like waybar, quickshell DMS, and KDE Plasma 6 only implement `StatusNotifierItem` (KDE SNI). XEmbed is a no-op there, so the app log says `trayActive=true, hasIcon=true` while the icon never registers on the bus and never shows up in the panel. **Fix**: `install.sh` writes a `start.sh` that prepends `Unity:` to `XDG_CURRENT_DESKTOP` (e.g. `Unity:XFCE`), which switches Electron to `ayatana-appindicator` (SNI). The original desktop name is preserved in the colon-separated list so other XDG-aware programs keep working.
8. **First LLM call blocks for minutes when multiple connectors are enabled (5.0.3+wb3)**: Upstream codebuddy CLI's stdio MCP settle waits up to 30s per server serially. **Fix**: `start.sh` exports `MCP_TIMEOUT=3000` by default, paired with the `cliMcpSettleTimeoutInteractive` patch in `cli/dist/codebuddy.js`. Healthy servers respond in <1s, slow ones get skipped via the upstream `Promise.race`.
9. **WorkBuddy App / Mini Program remote control requires manual re-enable after restart**: Upstream `ClawLifecycle.start()` restores saved channels and starts Centrifugo, but the `wechatmp` integration's default-enabled state can remain only in local config, while backend registration and remote subscription are not fully replayed after desktop restart. **Fix**: The Linux runtime patch delays and replays the enabled `wechatmp` integration after Claw lifecycle startup, writes the enabled state again, registers it with the backend, and starts Centrifugo so users no longer need to manually toggle "WeChat / Mini Program Integration" off and on after reopening the app.

## Version Compatibility

The current patches have been verified against official WorkBuddy **4.22.10** (build `27634624-ec5e02bd`). Higher versions of the DMG may have upstream code structure changes that prevent patches from applying correctly. If you encounter build failures or runtime issues, please file an Issue in this repository with the DMG version number you are using.

## Useful Custom Configurations

To customize the installation path or switch Electron mirrors, execute the following commands:

```bash
# Custom installation directory
WORKBUDDY_INSTALL_DIR=/opt/tmp/workbuddy-app bash install.sh
# Switch Electron mirror source
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bash install.sh
# Custom Electron headers download URL
ELECTRON_HEADERS_URL=https://artifacts.electronjs.org/headers/dist bash install.sh
```

Metadata fields written into the produced packages (`make deb` / `make rpm` / `make pacman`) can also be overridden via environment variables:

```bash
# Override the Maintainer field in the .deb control / .PKGINFO.
# For .deb and pacman the value is the full "Name <email>" string.
MAINTAINER="LeisureLinux <AlbertXu@FreeLAMP.com>" make deb
# For .rpm, only the name (the part before any whitespace) is submitted
# as `packager` via `rpmbuild --define`.
MAINTAINER_NAME="LeisureLinux" make rpm

# Override the Homepage / URL / url field of the produced package.
# Also rewrites the download link inside the long description.
HOMEPAGE="https://workbuddy.cn/" make deb
```

Defaults, matching the committed `packaging/linux/control` template:

- `MAINTAINER` / `MAINTAINER_NAME` → `LeisureLinux <AlbertXu@FreeLAMP.com>` / `LeisureLinux`
- `HOMEPAGE` → `https://workbuddy.cn/`

## Repository Maintenance Rules

The following directories are ignored by Git because they store upstream software and generated package files, **never commit them manually**:

- `downloads/`
- `build/`
- `workbuddy-app/`
- `dist/`
- `reference/`

Committing DMG installers, extracted `.app` bundles, generated Linux application directories and various native package artifacts is prohibited.

## Disclaimer

This project is an **unofficial community open-source tool** and has no affiliation with Tencent. WorkBuddy is a product of Tencent (copyright © 2026 Tencent Cloud Computing (Beijing) Co., Ltd. and Tencent Technology (Shenzhen) Co., Ltd. All rights reserved). This tool does not redistribute any official WorkBuddy software; it only automates the format conversion process for users' genuine installers.

The WorkBuddy application produced by this tool remains governed by Tencent's official agreements; please refer to the latest terms of service and privacy policy on the official website or in the application.

By using this tool, you acknowledge and agree to the following:

1. **User Responsibility**: You are responsible for ensuring that the DMG installer you obtained is from a legitimate source and that your usage complies with WorkBuddy's End User License Agreement (EULA) and related terms of service.
2. **No Warranty**: This tool is provided "AS IS" without any express or implied warranties, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.
3. **No Official Support**: This project is an independent community project. Tencent does not provide any technical support for this tool. For issues encountered in the Linux porting environment, please file an Issue in this repository. **Do not report to official customer service.**
4. **Use at Your Own Risk**: All consequences arising from using this tool for format conversion and running the application are borne solely by the user.
5. **Trademark Notice**: WorkBuddy, CodeBuddy, and related logos are trademarks or registered trademarks of Tencent. The use of these names in this project is for descriptive purposes only and does not imply any official endorsement or authorization.
6. **Takedown Policy**: If Tencent or any rights holder objects to this project, please contact the maintainer via a GitHub issue or email. The maintainer commits to immediately suspending maintenance and processing the GitHub repository in accordance with the rights holder's reasonable request upon receipt of such objection.
7. **Project Purpose**: This project (including this GitHub repository and any related automation scripts) is intended solely for technical research and proof-of-concept purposes. The original author has never distributed, and will never distribute, any official proprietary binary software.
8. **Third-Party Responsibility**: Any copyright disputes or legal liabilities arising from third-party forks, modifications, or the independent publication of pre-compiled binary installation packages (including GitHub Releases) shall be the sole responsibility of such third parties, and are entirely unrelated to the original author.

## License

This project (conversion scripts and related recipes) is licensed under the MIT License; see [LICENSE](LICENSE). The MIT grant covers only the conversion tooling in this repository and **does NOT extend to the Tencent WorkBuddy binaries installed via this tool**, which remain subject to Tencent's proprietary terms.
