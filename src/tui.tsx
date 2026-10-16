import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "target"])
const MAX_DEPTH = 8
const MAX_ENTRIES = 5000
const MAX_ROWS = 45

type FileNode = {
  name: string
  path: string
  directory: boolean
  depth: number
}

type VisibleNode = FileNode & {
  indent: number
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

function FileTreePanel() {
  const context = usePlugin()
  const location = context.location ?? context.data.location.default()
  const root = path.resolve(location?.directory ?? process.cwd())

  const [rootEntries, setRootEntries] = createSignal<FileNode[]>([])
  const [revision, setRevision] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const loaded = new Map<string, FileNode[]>()
  const expanded = new Set<string>()

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

  const copySelected = async (node = visible()[selected()]) => {
    if (!node) return
    try {
      await copyToClipboard(node.path)
      context.ui.toast.show({
        title: "Path copied",
        message: node.path,
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
                  onMouseDown={() => {
                    setSelected(item.index)
                    if (item.node.directory) void toggleDirectory(item.node)
                    else void copySelected(item.node)
                  }}
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
      <text fg={context.theme.text.muted}>Click file to copy path</text>
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
