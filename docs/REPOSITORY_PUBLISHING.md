# GitHub 发布与隐私清单

这份清单用于避免把个人工作台里的本地资料误提交到公开仓库。

## 可以上传

- `src/`、`web/`、`test/`：源代码、页面和合成测试。
- `scripts/`、`启动工作台.cmd`、`启动工作台.vbs`：安装、启动和导入工具。
- `docs/`、`CONTEXT.md`、`README.md`：设计、领域和使用说明。
- `package.json`、`.gitignore`、`.gitattributes`、`config.example.json`：项目配置与发布元数据。
- `icon.png`、`个人工作台-透明抠图.png` 和 `个人工作台-透明图标.ico`：源图与最终应用图标资源。公开前需要确认图像素材的版权或再分发许可；同目录下的其他 ICO/PNG 是本地生成的重复版本，不必上传。

## 不要上传

- `data/`：包含 SQLite 数据库、WAL/SHM 文件以及真实工作台记录。
- `config.json`：包含本机绝对数据路径。
- `.runtime/`：一键安装器下载的本地 Node.js 便携运行时，不属于源码发布内容。
- `我的课表.xlsx`、`我的课表.doc`：个人课程安排文件。
- 简历原文件、受管 `resumes/` 目录和 `.pwb` 备份：可能包含个人身份、求职和联系方式。
- `safety-backups/`、`staging/`、SQLite 临时文件、日志、临时目录。
- `task_plan.md`、`progress.md`、`findings.md`：本地开发过程日志，不是产品运行所需文件。
- 任何 API key、密码、令牌、私钥或包含个人信息的导出文件。

## 发布前自检

```powershell
git status --short
git add -A
git status --short
git diff --cached --stat
git diff --cached --name-only
```

确认暂存清单中没有 `data/`、`config.json`、`我的课表`、`resumes/`、`.pwb` 或个人规划日志，再创建提交。提交后可再次运行：

```powershell
git ls-files
git grep -n -I -E "api[_-]?key|password|secret|token|BEGIN .*PRIVATE KEY"
```

如发现真实凭据，先移除并立即撤销/轮换凭据，再继续推送；仅从工作区删除不能消除已经进入 Git 历史的秘密。
