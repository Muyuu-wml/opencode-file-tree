# OpenCode File Tree

为 OpenCode 2 终端界面提供侧边栏文件树、只读文件预览、文件内搜索、Git 左右对比，以及把选中代码加载到聊天输入框。

## 功能

- **侧边栏文件树**：按需展开目录，双击预览文件，右键复制文件绝对路径。
- **文件预览**：跟随 OpenCode 主题，提供语法高亮、行号、文件路径和 Git 状态。
- **文件内搜索**：输入关键词后自动定位，支持循环切换匹配项并显示当前序号。
- **Git 左右对比**：左侧为 HEAD 版本，右侧为当前工作区，提供增删高亮、行号与同步滚动。
- **加载到聊天**：拖选代码后右键选择 `Add to chat`，把文件绝对路径和所选代码写入聊天输入框；菜单显示所选行数，并带悬停反馈。
- **自适应弹窗**：预览居中显示；开启 Git 对比时加宽至接近终端全宽，关闭后恢复原宽度。
- **文件信息**：显示分支、换行符类型、文件大小、行数和语言。

## 安装与加载

### 1. 安装依赖

在插件目录执行：

```bash
npm install
```

### 2. 配置 OpenCode

将插件目录的绝对路径加入全局 `~/.config/opencode/cli.json` 的 `plugins` 数组。Windows 默认位置为 `%USERPROFILE%\.config\opencode\cli.json`；设置了 `XDG_CONFIG_HOME` 时使用该目录下的 `opencode/cli.json`。

```json
{
  "plugins": ["D:/go_space/src/opencode-file-tree"]
}
```

将示例路径替换为实际安装位置；已有插件时追加到原数组中。重启 OpenCode，并打开会话侧边栏，即可看到 **Files** 文件树。

## 操作说明

### 文件树

| 操作 | 功能 |
| --- | --- |
| 单击目录 | 展开或折叠 |
| 双击文件 | 打开文件预览 |
| 右键文件 | 复制绝对路径 |
| 点击 Files 标题行右侧的 `Refresh` | 清除目录缓存并重新读取文件树，折叠已展开的目录 |

文件树读取当前会话位置对应的本地目录，目录优先排列。

### 文件预览

| 操作 | 功能 |
| --- | --- |
| 滚轮 / 方向键 | 滚动内容 |
| 拖选代码 | 选中并高亮文本（双击选词） |
| 右键选中内容 → `Add to chat` | 把绝对路径和所选代码写入聊天输入框 |
| `Ctrl+F` | 打开文件搜索；在 Git 对比中使用时返回文件视图 |
| `Enter` | 搜索时跳到下一个匹配 |
| `Shift+Enter` | 搜索时跳到上一个匹配 |
| `Ctrl+G` | 开启或关闭 Git 对比 |
| 点击右上角 `Git diff` | 开启或关闭 Git 对比 |
| `Esc` | 关闭右键菜单；退出搜索；未打开搜索时关闭预览 |

搜索使用不区分大小写的字面匹配，不解析正则表达式。输入关键词后自动定位首个匹配，搜索栏以 `当前序号/总数` 显示结果，切换到末尾后循环回到开头。

### 加载到聊天

在预览中拖选代码（双击可选中单词），在选区上右键会弹出菜单：

```text
╭────────────────────────────╮
│ + Add to chat              │
│   12 lines · path + code   │
╰────────────────────────────╯
```

标题栏是操作名称，副标题显示本次选中的行数和插入格式。鼠标悬停时边框与底色会提亮；`Esc`、点击代码区、打开搜索或切换 Git 对比都会关闭菜单。

点击菜单后，以下内容会追加到聊天输入框末尾，并保留原始缩进：

    D:\go_space\src\opencode-file-tree\src\tui.tsx

    ```typescript
    function example() {
      return "selected code"
    }
    ```

插入成功后预览自动关闭、焦点回到输入框，并提示 `Added to chat`，内容可继续编辑或直接发送。若无法定位聊天输入框（例如尚未进入会话界面），所选内容会复制到剪贴板并提示手动粘贴。

### Git 对比

对比展示当前文件相对于 HEAD 的差异片段，包含暂存和未暂存修改。新增文件的左侧为空。

开启对比时，弹窗自动加宽，为左右两栏提供更多空间；终端窗口缩放时同步调整。关闭对比或进入文件搜索后恢复普通预览宽度。

优先通过 OpenCode VCS 接口获取差异；接口未返回当前文件的修改或调用失败时，使用本地 Git 查询。请确保本地 `git` 命令可用。文件没有修改或 Git 读取失败时，弹窗会显示相应提示。

## 语法高亮

使用 tree-sitter，颜色来自当前 OpenCode 主题。

- **内置语法**：JavaScript、TypeScript、JSX、TSX、Markdown、Zig。
- **按需下载**：Go、Python、Rust、JSON、Bash、CSS、YAML、TOML 的语法资源首次使用时从 GitHub 获取，并在磁盘缓存。
- **禁用远程语法**：启动 OpenCode 前设置 `FILE_TREE_NO_REMOTE_GRAMMARS=1`，跳过额外语法注册。内置语法仍可使用。

## 当前限制

- 预览为只读，不支持编辑或保存文件。
- 单个文件最多预览 **1 MiB**；二进制文件显示提示。
- 文件读取与路径复制发生在运行终端插件的本机，不通过服务端读取远程文件。
- 文件树默认跳过 `.git`、`node_modules`、`.next`、`dist`、`build`、`coverage`、`target` 目录。
- 文件树限制展开深度及条目数量，侧边栏最多显示 45 行，并根据终端高度缩减。
- “加载到聊天”依赖 TUI 的编辑器接口；OpenCode 2.1 尚未提供插件级聊天输入框 API，宿主升级后可能需要适配。无法定位输入框时会退化为复制到剪贴板。

## 开发

```bash
npm run typecheck
```

开发依赖中的 `@opentui/core` 和 `@opentui/solid` 当前为 `0.6.6`，`@opencode/plugin` 与宿主版本对齐（`2.1.2`）；插件运行时使用宿主提供的实例。OpenTUI 0.6 要求 `SyntaxStyle` 显式绑定资源归属，插件传入 `renderer.nativeScene`。

OpenCode 2.1 尚未提供写入聊天输入框的插件 API（`context.ui.prompt`）。插件在打开预览时记录 `renderer.currentFocusedEditor`，通过编辑器的 `insertText` 追加内容，与宿主处理 `tui.prompt.append` 的方式一致；宿主提供官方接口后应改为调用官方接口。

```text
src/
  index.ts           服务端插件入口
  tui.tsx            文件树、预览弹窗与交互
  preview-search.ts  搜索匹配与位置计算
  preview-git.ts     本地 Git 差异查询
```
