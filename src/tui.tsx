import { spawn } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { MouseEvent as TuiMouseEvent } from "@opentui/core"
import { Plugin, usePlugin } from "@opencode/plugin/tui"

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "target"])
const MAX_DEPTH = 8
const MAX_ENTRIES = 5000
const MAX_ROWS = 45
const MAX_FILE_SIZE = 1024 * 1024
const DOUBLE_CLICK_DELAY = 350

type FileNode = {
  name: string
  path: string
  directory: boolean
  depth: number
}

type VisibleNode = FileNode & {
  indent: number
}

type FilePreview = {
  node: FileNode
  content: string
  branch?: string
  diff?: {
    status: "added" | "deleted" | "modified"
    additions: number
    deletions: number
    patch: string
  }
}

async function runClipboardCommand(command: string, args: string[], value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] })
    let error = ""

    child.stderr?.on("data", (chunk) => {
      error += String(chunk)
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(error || `${command} exited with code ${code ?? "unknown"}`))
    })
    child.stdin.end(value, "utf8")
  })
}

async function copyToClipboard(value: string): Promise<void> {
  const candidates: Array<[string, string[]]> =
    process.platform === "win32"
      ? [["clip.exe", [] as string[]]]
      : process.platform === "darwin"
        ? [["pbcopy", [] as string[]]]
        : [
            ["wl-copy", [] as string[]],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]

  let lastError: unknown
  for (const [command, args] of candidates) {
    try {
      await runClipboardCommand(command, args, value)
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No clipboard command is available")
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

function FilePreviewDialog(props: { preview: () => FilePreview | undefined }) {
  const current = () => props.preview()

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <Show when={current()}>
        {(preview) => (
          <>
            <text fg="cyan">{preview().node.path}</text>
            <Show when={preview().branch}>
              <text fg="yellow">Git branch: {preview().branch}</text>
            </Show>
            <scrollbox flexGrow={1} stickyScroll={false}>
              <text wrapMode="none" fg="white">
                {preview().content}
              </text>
              <Show when={preview().diff}>
                {(diff) => (
                  <>
                    <text fg="yellow">
                      {`\nGit changes: ${diff().status} (+${diff().additions} -${diff().deletions})\n`}
                    </text>
                    <text wrapMode="none" fg="white">
                      {diff().patch}
                    </text>
                  </>
                )}
              </Show>
            </scrollbox>
            <text fg="gray">Esc to close</text>
          </>
        )}
      </Show>
    </box>
  )
}

function FileTreePanel() {
  const context = usePlugin()
  const location = context.location ?? context.data.location.default()
  const root = path.resolve(location?.directory ?? process.cwd())

  const [rootEntries, setRootEntries] = createSignal<FileNode[]>([])
  const [revision, setRevision] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [preview, setPreview] = createSignal<FilePreview>()
  const loaded = new Map<string, FileNode[]>()
  const expanded = new Set<string>()
  let lastClick: { path: string; time: number } = { path: "", time: 0 }

  const loadDirectory = async (directory: string, depth: number): Promise<FileNode[]> => {
    const cached = loaded.get(directory)
    if (cached) return cached

    if (depth > MAX_DEPTH) return []

    const entries = await readdir(directory, { withFileTypes: true })
    const nodes = entries
      .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)))
      .map((entry) => ({
        name: entry.name,
        path: path.join(directory, entry.name),
        directory: entry.isDirectory(),
        depth,
      }))
      .sort((left, right) => {
        if (left.directory !== right.directory) return left.directory ? -1 : 1
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      })

    loaded.set(directory, nodes)
    return nodes
  }

  const visible = createMemo<VisibleNode[]>(() => {
    revision()
    const result: VisibleNode[] = []

    const append = (nodes: FileNode[], indent: number) => {
      for (const node of nodes) {
        if (result.length >= MAX_ENTRIES) return
        result.push({ ...node, indent })
        if (node.directory && expanded.has(node.path)) {
          append(loaded.get(node.path) ?? [], indent + 1)
        }
      }
    }

    append(rootEntries(), 0)
    return result
  })

  const displayed = createMemo(() => {
    const rows = visible()
    const index = selected()
    const start = Math.max(0, Math.min(index - Math.floor(MAX_ROWS / 2), rows.length - MAX_ROWS))
    return rows.slice(start, start + MAX_ROWS).map((node, offset) => ({
      node,
      index: start + offset,
    }))
  })

  const refresh = async () => {
    setLoading(true)
    setError(undefined)
    loaded.clear()
    expanded.clear()
    setSelected(0)
    try {
      setRootEntries(await loadDirectory(root, 0))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
      setRevision((value) => value + 1)
    }
  }

  const toggleDirectory = async (node: FileNode) => {
    if (!node.directory) return
    if (expanded.has(node.path)) {
      expanded.delete(node.path)
    } else {
      try {
        await loadDirectory(node.path, node.depth + 1)
        expanded.add(node.path)
      } catch (cause) {
        context.ui.toast.show({
          title: "File tree",
          message: cause instanceof Error ? cause.message : String(cause),
          variant: "error",
        })
      }
    }
    setRevision((value) => value + 1)
  }

  const copySelected = async (node?: FileNode) => {
    const target = node ?? visible()[selected()]
    if (!target) return
    try {
      await copyToClipboard(target.path)
      context.ui.toast.show({
        title: "Path copied",
        message: target.path,
        variant: "success",
        duration: 2500,
      })
    } catch (cause) {
      context.ui.toast.show({
        title: "Copy failed",
        message: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      })
    }
  }

  const loadGitInfo = async (filePath: string) => {
    try {
      const location = { directory: root }
      const [vcs, changes] = await Promise.all([
        context.client.vcs.get({ location }),
        context.client.vcs.diff({ location, mode: "working", context: 3 }),
      ])
      const relativePath = normalizeGitPath(path.relative(root, filePath))
      const comparisonPath = process.platform === "win32" ? relativePath.toLowerCase() : relativePath
      const fileDiff = changes.data.find((change) => {
        const changePath = normalizeGitPath(change.file)
        const normalizedChangePath = process.platform === "win32" ? changePath.toLowerCase() : changePath
        return normalizedChangePath === comparisonPath || normalizedChangePath.endsWith(`/${comparisonPath}`)
      })

      return {
        branch: vcs.data.branch.current ?? vcs.data.branch.default,
        diff: fileDiff,
      }
    } catch {
      return undefined
    }
  }

  const openFile = async (node: FileNode) => {
    if (node.directory) return
    setPreview({ node, content: "Loading file..." })
    context.ui.dialog.set({ size: "xlarge", centered: true })
    context.ui.dialog.show(
      () => <FilePreviewDialog preview={preview} />,
      () => setPreview(undefined),
    )

    try {
      const fileStats = await stat(node.path)
      if (fileStats.size > MAX_FILE_SIZE) {
        setPreview({
          node,
          content: `This file is too large to preview (${Math.ceil(fileStats.size / 1024)} KB).`,
        })
        return
      }

      const [content, git] = await Promise.all([readFile(node.path, "utf8"), loadGitInfo(node.path)])
      setPreview({ node, content, branch: git?.branch, diff: git?.diff })
    } catch (cause) {
      setPreview({
        node,
        content: `Unable to open file: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
  }

  const handleNodeMouseDown = (event: TuiMouseEvent, item: { node: FileNode; index: number }) => {
    const node = item.node
    setSelected(item.index)

    if (event.button === 2) {
      if (!node.directory) void copySelected(node)
      event.preventDefault()
      return
    }

    if (event.button !== 0) return
    if (node.directory) {
      void toggleDirectory(node)
      return
    }

    const now = Date.now()
    const isDoubleClick = lastClick.path === node.path && now - lastClick.time <= DOUBLE_CLICK_DELAY
    lastClick = { path: node.path, time: now }
    if (isDoubleClick) void openFile(node)
  }

  onMount(() => void refresh())

  return (
    <box flexDirection="column" padding={1}>
      <text fg={context.theme.text.muted}>Files</text>
      <text fg={context.theme.text.base} truncate>
        {root}
      </text>
      <Show when={!loading()} fallback={<text fg={context.theme.text.muted}>Loading...</text>}>
        <Show when={!error()} fallback={<text fg={context.theme.error}>{error()}</text>}>
          <For each={displayed()}>
            {(item) => {
              const active = () => item.index === selected()
              const marker = () => (item.node.directory ? (expanded.has(item.node.path) ? "▾ " : "▸ ") : "  ")
              return (
                <box
                  flexDirection="row"
                  onMouseDown={(event) => handleNodeMouseDown(event, item)}
                >
                  <text fg={active() ? context.theme.accent : context.theme.text.base}>
                    {active() ? "› " : "  "}
                    {"  ".repeat(item.node.indent)}
                    {marker()}
                    {item.node.name}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>
      <text fg={context.theme.text.muted}>Double-click file to view · Right-click to copy path</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-file-tree",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <FileTreePanel />,
    })

    return unregister
  },
})
