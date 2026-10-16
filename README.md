# OpenCode File Tree

OpenCode CLI/TUI 插件：在右侧状态栏常驻展示当前目录的文件树。

- 插件加载后自动显示文件树
- 点击文件复制绝对路径到剪贴板
- 点击目录展开或折叠

## 安装开发依赖

```bash
npm install
npm run typecheck
```

## 在 OpenCode 中加载

在 `cli.json` 中加入：

```json
{
  "plugins": ["D:/go_space/src/opencode-file-tree"]
}
```

重启 OpenCode 后，文件树会自动显示在右侧状态栏。
