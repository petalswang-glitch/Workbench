# 个人工作台

一个运行在 Windows 本机、通过浏览器使用的工作、学习、求职和个人计划管理工具。它只监听本机地址，数据保存在你选择的本地目录，不需要账号、云数据库或在线字体。

## 功能

- 首页：今日课程、今日计划、快速备忘和近期摘要。
- 课表：教学周 × 星期 × 节次视图，支持跨节次、单双周、自定义周次、作息设置和 XLSX 导入。
- 岗位投递：表格化记录岗位、渠道、日期、状态、面试和简历版本关联。
- 简历：按方向管理 PDF、DOC、DOCX 版本，支持应用内预览、归档和原位重新关联文件。
- 计划：日期、优先级、状态、分类、筛选和逾期提示。
- 设置：白天/夜间场景、完整备份和整体恢复。

## Windows 快速开始

### 双击启动（推荐）

1. 安装 [Node.js 24 或更高版本](https://nodejs.org/)。
2. 双击 `启动工作台.vbs`，或为它创建桌面快捷方式。
3. 服务会在后台启动，浏览器自动打开 `http://127.0.0.1:47821`，不会弹出终端窗口。
4. 第一次运行会要求选择数据保存目录；配置会写入本机的 `config.json`，该文件不会上传到 GitHub。

桌面快捷方式的图标可以使用仓库中的 `个人工作台-透明图标.ico`。`启动工作台.cmd` 仍保留，适合需要查看启动错误时使用；它可能显示终端窗口。

再次启动时，如果工作台已经运行，会直接打开已有页面，不会启动第二个写入进程。

### 从 GitHub 一键安装

这是本地安装方式，不会把个人数据上传到 GitHub。Windows 用户在 PowerShell 中执行下面一条命令即可；不需要提前手动安装 Node.js：

```powershell
irm https://raw.githubusercontent.com/petalswang-glitch/Workbench/main/scripts/install-workbench.ps1 | iex
```

安装脚本会从当前 `main` 分支下载源码到 `%LOCALAPPDATA%\PersonalWorkbench`，检查 Node.js 24 或更高版本；如果系统没有合适版本，会从 [Node.js 官方发行目录](https://nodejs.org/dist/index.json) 下载匹配当前 Windows 架构的便携运行时到 `.runtime`，不修改系统 PATH。之后脚本会创建 `Personal Workbench` 桌面快捷方式并直接启动工作台。重新执行可以更新程序文件；已有的 `config.json`、`data/` 和 `.runtime/` 不会被源码覆盖。

安装器支持 `-NoLaunch` 和 `-NoShortcut` 参数，便于在命令行中只安装不启动或只更新程序文件；普通用户无需传参数。

上面的命令会直接执行远程脚本。如果希望先审阅脚本，再运行安装器，可以执行：

```powershell
$installer = Join-Path $env:TEMP 'install-workbench.ps1'
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/petalswang-glitch/Workbench/main/scripts/install-workbench.ps1' -OutFile $installer
notepad $installer
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

安装完成后，桌面快捷方式调用的是无终端窗口的 `启动工作台.vbs`。这条一键安装命令目前面向 Windows；其他系统需要单独增加安装入口。

## 从 GitHub 获取

```powershell
git clone https://github.com/petalswang-glitch/Workbench.git personal-workbench
Set-Location personal-workbench
node --test
```

然后双击 `启动工作台.vbs`。也可以复制 `config.example.json` 为 `config.json` 后修改数据目录，但通常直接首次启动并选择目录更安全。

## 开发验证

项目不需要安装 npm 依赖：

```powershell
node --test
node --check src/server.js
node --check web/app.js
```

直接开发运行：

```powershell
node src/server.js
```

导入其他课表时，可在应用内使用“导入 XLSX”；解析只处理固定课表，不包含临时调课内容。

## 数据与隐私

- 服务只监听 `127.0.0.1`，不会向局域网开放。
- 简历文件会复制到你选择的数据目录中统一管理。
- `.pwb` 备份包含业务数据和受管简历文件，应像原始简历一样保护。
- 本地数据默认不加密，请使用 Windows 账户和磁盘权限保护电脑。
- 公开仓库不包含本机 SQLite 数据、配置文件、课程文件、简历文件或备份。

## 仓库结构

```text
src/                         本地 API、SQLite 存储、备份和导入逻辑
web/                         浏览器界面、样式和交互
test/                        Node.js 内置测试
scripts/                     Windows 安装、启动和课表导入脚本
docs/                        设计与公开仓库维护说明
启动工作台.vbs               无终端窗口的 Windows 启动入口
启动工作台.cmd               可查看启动过程的命令行入口
config.example.json           脱敏配置示例
```

## 公开发布注意事项

当前仓库特意不附开源许可证；如果要允许他人复制、修改或分发，请根据你的意愿补充合适的 `LICENSE`。图标中的人物素材公开前也应确认拥有相应的使用和再分发权。

更多上传/排除规则见 [`docs/REPOSITORY_PUBLISHING.md`](docs/REPOSITORY_PUBLISHING.md)。
