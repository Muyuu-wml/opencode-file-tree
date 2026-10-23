/** @jsxImportSource @opentui/solid */
import { spawn } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import {
  addDefaultParsers,
  CliRenderEvents,
  CodeRenderable,
  isRenderable,
  LineNumberRenderable,
  pathToFiletype,
  SyntaxStyle,
  TextAttributes,
  type BoxRenderable,
  type CliRenderer,
  type FiletypeParserOptions,
  type InputRenderable,
  type MouseEvent as TuiMouseEvent,
  type NativeResourceOwner,
  type RGBA,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { loadLocalGitInfo, type FileChange } from "./preview-git.js"
import { findSearchMatches, searchPosition } from "./preview-search.js"

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "target"])
const MAX_DEPTH = 8
const MAX_ENTRIES = 5000
const MAX_ROWS = 45
const MIN_ROWS = 4
// Rows outside the tree itself: the host sidebar's outer padding, session
// title, and footer slot (~5), plus this panel's Files/Refresh header, root path,
// hint line, and one blank row of breathing room (~4). The tree never grows
// past these, so it cannot run flush against the bottom of the sidebar.
const RESERVED_ROWS = 9
const DOUBLE_CLICK_DELAY = 350

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1024 * 1024
const BINARY_SNIFF_LENGTH = 8000
const STYLE_RELEASE_DELAY = 250
const SELECTION_MENU_WIDTH = 30
const SELECTION_MENU_HEIGHT = 4

type FileNode = {
  name: string
  path: string
  directory: boolean
  depth: number
}

type VisibleNode = FileNode & {
  indent: number
}

type PreviewStatus = "loading" | "ready" | "binary" | "too-large" | "error"

type FilePreview = {
  node: FileNode
  status: PreviewStatus
  content: string
  message?: string
  sizeBytes: number
  relativePath: string
  branch?: string
  change?: FileChange
  gitMessage?: string
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

// Tree-sitter grammars bundled with @opentui/core cover js/ts/jsx/tsx, markdown
// and zig. Extra languages are registered OpenCode-style: the wasm and query
// files are downloaded from these pinned URLs on first use and disk-cached.
// Offline machines fall back to plain text; set FILE_TREE_NO_REMOTE_GRAMMARS=1
// to skip registration entirely.
const REMOTE_PARSERS: FiletypeParserOptions[] = [
  {
    filetype: "json",
    wasm: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm",
      ],
    },
  },
  {
    filetype: "bash",
    wasm: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/bash/highlights.scm",
      ],
    },
  },
  {
    filetype: "python",
    wasm: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
    queries: {
      highlights: [
        "https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm",
      ],
    },
  },
  {
    filetype: "rust",
    wasm: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/highlights.scm",
      ],
    },
  },
  {
    filetype: "go",
    wasm: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/highlights.scm",
      ],
    },
  },
  {
    filetype: "css",
    wasm: "https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/css/highlights.scm",
      ],
    },
  },
  {
    filetype: "yaml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/yaml/highlights.scm",
      ],
    },
  },
  {
    filetype: "toml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/toml/highlights.scm",
      ],
    },
  },
]

let remoteParsersRegistered = false

function ensureRemoteParsers(): void {
  if (remoteParsersRegistered) return
  remoteParsersRegistered = true
  if (process.env.FILE_TREE_NO_REMOTE_GRAMMARS) return
  try {
    addDefaultParsers(REMOTE_PARSERS)
  } catch {
    // Grammars unavailable — previews degrade to plain text.
  }
}

/** Minimal structural copy of the OpenCode resolved-theme tokens this plugin reads. */
interface PreviewTheme {
  text: {
    base: RGBA
    muted: RGBA
    action: Record<string, { base: RGBA }>
    feedback: Record<string, { base: RGBA; muted: RGBA }>
  }
  background: {
    base: RGBA
    raised: { base: RGBA; high: RGBA; max: RGBA }
  }
  diff: {
    text: { added: RGBA; removed: RGBA; context: RGBA; hunkHeader: RGBA }
    background: { added: RGBA; removed: RGBA; context: RGBA }
    highlight: { added: RGBA; removed: RGBA }
    lineNumber: { text: RGBA; background: { added: RGBA; removed: RGBA } }
  }
  syntax: Record<string, RGBA>
  markdown: Record<string, RGBA>
  surface: (name: string) => PreviewTheme
}

/**
 * Builds a SyntaxStyle from the active theme, mirroring the token mapping
 * OpenCode itself uses (`generateSyntax` in @opencode/theme). This makes file
 * previews match the colors of OpenCode's own code blocks and diff viewer.
 */
function buildSyntaxStyle(theme: PreviewTheme, owner: NativeResourceOwner): SyntaxStyle {
  const syntax = theme.syntax
  const markdown = theme.markdown
  const feedback = theme.text.feedback
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text.base },
    search: { fg: theme.background.base, bg: theme.text.action.primary.base, bold: true },
    comment: { fg: syntax.comment, italic: true },
    "comment.documentation": { fg: syntax.comment, italic: true },
    string: { fg: syntax.string },
    symbol: { fg: syntax.string },
    character: { fg: syntax.string },
    "character.special": { fg: syntax.string },
    number: { fg: syntax.number },
    boolean: { fg: syntax.number },
    constant: { fg: syntax.number },
    float: { fg: syntax.number },
    keyword: { fg: syntax.keyword, italic: true },
    "keyword.import": { fg: syntax.keyword },
    "keyword.export": { fg: syntax.keyword },
    "keyword.return": { fg: syntax.keyword, italic: true },
    "keyword.conditional": { fg: syntax.keyword, italic: true },
    "keyword.conditional.ternary": { fg: syntax.operator },
    "keyword.repeat": { fg: syntax.keyword, italic: true },
    "keyword.coroutine": { fg: syntax.keyword, italic: true },
    "keyword.function": { fg: syntax.function },
    "keyword.type": { fg: syntax.type, bold: true, italic: true },
    "keyword.operator": { fg: syntax.operator },
    "keyword.directive": { fg: syntax.keyword, italic: true },
    "keyword.modifier": { fg: syntax.keyword, italic: true },
    "keyword.exception": { fg: syntax.keyword, italic: true },
    operator: { fg: syntax.operator },
    punctuation: { fg: syntax.punctuation },
    "punctuation.bracket": { fg: syntax.punctuation },
    "punctuation.delimiter": { fg: syntax.operator },
    "punctuation.special": { fg: syntax.operator },
    variable: { fg: syntax.variable },
    "variable.parameter": { fg: syntax.variable },
    "variable.member": { fg: syntax.function },
    "variable.builtin": { fg: feedback.error.base },
    "variable.super": { fg: feedback.error.base },
    parameter: { fg: syntax.variable },
    field: { fg: syntax.variable },
    property: { fg: syntax.variable },
    function: { fg: syntax.function },
    "function.builtin": { fg: feedback.error.base },
    "function.call": { fg: syntax.variable },
    "function.method": { fg: syntax.function },
    "function.method.call": { fg: syntax.variable },
    constructor: { fg: syntax.function },
    type: { fg: syntax.type },
    "type.builtin": { fg: feedback.error.base },
    "type.definition": { fg: syntax.type, bold: true },
    module: { fg: syntax.type },
    "module.builtin": { fg: feedback.error.base },
    class: { fg: syntax.type },
    namespace: { fg: syntax.type },
    "markup.heading": { fg: markdown.heading, bold: true },
    "markup.heading.1": { fg: markdown.heading, bold: true, underline: true },
    "markup.heading.2": { fg: markdown.heading, bold: true },
    "markup.heading.3": { fg: markdown.heading, bold: true },
    "markup.heading.4": { fg: markdown.heading, bold: true },
    "markup.heading.5": { fg: markdown.heading, bold: true },
    "markup.heading.6": { fg: markdown.heading, bold: true },
    "markup.bold": { fg: markdown.strong, bold: true },
    "markup.strong": { fg: markdown.strong, bold: true },
    "markup.italic": { fg: markdown.emphasis, italic: true },
    "markup.list": { fg: markdown.listItem },
    "markup.list.checked": { fg: feedback.success.base },
    "markup.list.unchecked": { fg: theme.text.muted },
    "markup.quote": { fg: markdown.blockQuote, italic: true },
    "markup.raw": { fg: markdown.code },
    "markup.raw.block": { fg: markdown.code },
    "markup.raw.inline": { fg: markdown.code, bg: theme.background.base },
    "markup.link": { fg: markdown.link, underline: true },
    "markup.link.url": { fg: markdown.link, underline: true },
    "markup.link.label": { fg: markdown.linkText, underline: true },
    "markup.underline": { fg: theme.text.base, underline: true },
    "markup.strikethrough": { fg: theme.text.muted },
    label: { fg: markdown.linkText },
    spell: { fg: theme.text.base },
    nospell: { fg: theme.text.base },
    attribute: { fg: feedback.warning.base },
    annotation: { fg: feedback.warning.base },
    tag: { fg: feedback.error.base },
    "tag.attribute": { fg: syntax.keyword },
    "tag.delimiter": { fg: syntax.operator },
    debug: { fg: theme.text.muted },
    "comment.error": { fg: feedback.error.base, italic: true, bold: true },
    "comment.warning": { fg: feedback.warning.base, italic: true, bold: true },
    "comment.todo": { fg: feedback.info.base, italic: true, bold: true },
    "comment.note": { fg: feedback.info.base, italic: true, bold: true },
    "diff.plus": { fg: theme.diff.text.added, bg: theme.diff.background.added },
    "diff.minus": { fg: theme.diff.text.removed, bg: theme.diff.background.removed },
    "diff.delta": { fg: theme.diff.text.context, bg: theme.diff.background.context },
    error: { fg: feedback.error.base, bold: true },
    warning: { fg: feedback.warning.base, bold: true },
    info: { fg: feedback.info.base },
  }, owner)
}

/** Releases a SyntaxStyle after its renderables are gone. */
function releaseSyntaxStyle(style: SyntaxStyle): void {
  setTimeout(() => {
    try {
      style.destroy()
    } catch {
      // Renderer may already be gone.
    }
  }, STYLE_RELEASE_DELAY)
}

// ---------------------------------------------------------------------------
// Chat composer
// ---------------------------------------------------------------------------

/** The host's chat input, structurally typed so any editor-like renderable fits. */
type ComposerEditor = {
  readonly isDestroyed: boolean
  readonly y: number
  readonly plainText?: string
  insertText(text: string): void
  gotoBufferEnd(options?: { select?: boolean }): unknown
  focus(): void
}

function isComposerEditor(value: unknown): value is ComposerEditor {
  if (!value || typeof value !== "object") return false
  const editor = value as Partial<ComposerEditor>
  return (
    editor.isDestroyed !== true &&
    typeof editor.insertText === "function" &&
    typeof editor.gotoBufferEnd === "function"
  )
}

// OpenCode 2.1 has no TUI plugin API for writing to the composer yet. The host
// itself appends `tui.prompt.append` text with EditBufferRenderable.insertText,
// so remember the editor that is focused when a preview opens and do the same.
let composerEditor: ComposerEditor | undefined

function captureComposer(renderer: CliRenderer): void {
  const focused = renderer.currentFocusedEditor
  if (isComposerEditor(focused)) {
    composerEditor = focused
    return
  }

  // Nothing focused: the composer is the bottom-most editor on screen.
  let bottom: ComposerEditor | undefined
  const visit = (node: Renderable): void => {
    if (node.isDestroyed) return
    if (isComposerEditor(node) && (!bottom || node.y >= bottom.y)) bottom = node
    for (const child of node.getChildren()) visit(child)
  }
  visit(renderer.root)
  if (bottom) composerEditor = bottom
}

function appendToComposer(renderer: CliRenderer, text: string): boolean {
  const editor = composerEditor
  if (!editor || editor.isDestroyed) return false
  const existing = typeof editor.plainText === "string" ? editor.plainText : ""
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  editor.gotoBufferEnd()
  editor.insertText(`${separator}${text}`)
  editor.focus()
  renderer.requestRender()
  return true
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = {
  bash: "Shell Script",
  c: "C",
  clojure: "Clojure",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dart: "Dart",
  diff: "Diff",
  dockerfile: "Dockerfile",
  elixir: "Elixir",
  elm: "Elm",
  erlang: "Erlang",
  fsharp: "F#",
  go: "Go",
  groovy: "Groovy",
  handlebars: "Handlebars",
  haskell: "Haskell",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  json: "JSON",
  julia: "Julia",
  kotlin: "Kotlin",
  latex: "LaTeX",
  less: "Less",
  lua: "Lua",
  make: "Makefile",
  markdown: "Markdown",
  ocaml: "OCaml",
  perl: "Perl",
  php: "PHP",
  powershell: "PowerShell",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  sass: "Sass",
  scala: "Scala",
  scss: "SCSS",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  typescript: "TypeScript",
  typescriptreact: "TypeScript TSX",
  vim: "Vim",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  zig: "Zig",
}

function languageName(filetype: string | undefined): string {
  if (!filetype) return "Plain Text"
  return LANGUAGE_NAMES[filetype] ?? filetype.charAt(0).toUpperCase() + filetype.slice(1)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function countLines(content: string): number {
  if (!content) return 0
  return content.split("\n").length
}

function detectEol(content: string): "LF" | "CRLF" {
  return content.includes("\r\n") ? "CRLF" : "LF"
}

function isBinaryContent(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_LENGTH).includes("\u0000")
}

// ---------------------------------------------------------------------------
// Preview components
// ---------------------------------------------------------------------------

/**
 * Syntax-highlighted file content with a VSCode-style line-number gutter.
 *
 * CodeRenderable + LineNumberRenderable are built imperatively: the gutter
 * must adopt the code renderable as its target at construction time, and JSX
 * prop assignment cannot express that safely (it would bypass setTarget and
 * break teardown). The pair is destroyed explicitly on cleanup.
 */
function CodePane(props: {
  theme: PreviewTheme
  content: () => string
  filetype: () => string | undefined
  searchQuery: () => string
  activeMatch: () => [number, number] | undefined
  scroll: () => ScrollBoxRenderable | undefined
  onContextMenu: (x: number, y: number, text: string) => void
  onDismissMenu: () => void
}) {
  const context = usePlugin()
  let host: BoxRenderable | undefined
  let built: { wrapper: LineNumberRenderable; code: CodeRenderable; style: SyntaxStyle } | undefined

  const teardown = () => {
    const current = built
    built = undefined
    if (!current) return
    try {
      current.wrapper.destroyRecursively()
      const parent = current.wrapper.parent
      if (parent) parent.remove(current.wrapper)
    } catch {
      // Best effort — the dialog is closing anyway.
    }
    releaseSyntaxStyle(current.style)
  }

  onMount(() => {
    if (!host || built) return
    const style = buildSyntaxStyle(props.theme, context.renderer.nativeScene)
    const code = new CodeRenderable(context.renderer, {
      content: props.content(),
      filetype: props.filetype(),
      syntaxStyle: style,
      fg: props.theme.text.base,
      wrapMode: "none",
      conceal: false,
      selectionBg: props.theme.text.action.primary.base,
      selectionFg: props.theme.background.base,
      onMouseDown: (event) => {
        props.onDismissMenu()
        if (event.button !== 2) return
        event.preventDefault()
        const selection = context.renderer.getSelection()
        const text = selection && built && selection.selectedRenderables.includes(built.code)
          ? selection.getSelectedText()
          : ""
        if (!text.trim()) {
          context.ui.toast.show({
            title: "File preview",
            message: "Drag over code to select it first",
            variant: "info",
            duration: 2000,
          })
          return
        }
        props.onContextMenu(event.x, event.y, text)
      },
    })
    const wrapper = new LineNumberRenderable(context.renderer, {
      target: code,
      fg: props.theme.text.muted,
      minWidth: 3,
      paddingRight: 1,
    })
    host.add(wrapper)
    built = { wrapper, code, style }
  })

  createEffect(() => {
    const content = props.content()
    const filetype = props.filetype()
    const searchQuery = props.searchQuery().trim()
    const code = built?.code
    if (!code || code.isDestroyed) return
    code.onHighlight = (highlights, highlightContext) => {
      if (!searchQuery) return highlights
      const matches = findSearchMatches(highlightContext.content, searchQuery)
      return [
        ...highlights,
        ...matches.map(([start, end]) => [start, end, "search"] as [number, number, string]),
      ]
    }
    if (code.content !== content) code.content = content
    if (code.filetype !== filetype) code.filetype = filetype
  })

  createEffect(() => {
    const match = props.activeMatch()
    const current = built
    if (!current) return
    current.wrapper.clearAllLineColors()
    if (!match) return
    const position = searchPosition(props.content(), match[0])
    current.wrapper.setLineColor(position.line, { gutter: props.theme.background.raised.max })

    // Scroll after layout so a newly mounted pane has its full scroll range.
    const jump = () => {
      const scroll = props.scroll()
      if (!scroll || scroll.isDestroyed || current.code.isDestroyed) return
      const buffer = context.renderer.currentRenderBuffer
      const encoded = buffer.encodeUnicode(position.prefix)
      let column = 0
      try {
        for (const cell of encoded.data) column += cell.char === 9 ? 4 : cell.width
      } finally {
        buffer.freeUnicode(encoded)
      }
      const gutter = Math.max(3, String(countLines(props.content())).length) + 1
      scroll.scrollTo({
        x: Math.max(0, column + gutter - Math.floor(scroll.viewport.width / 2)),
        y: Math.max(0, position.line - Math.floor(scroll.viewport.height / 2)),
      })
    }
    context.renderer.once(CliRenderEvents.FRAME, jump)
    context.renderer.requestRender()
    onCleanup(() => context.renderer.off(CliRenderEvents.FRAME, jump))
  })

  onCleanup(teardown)

  return <box ref={host} />
}

/** Side-by-side diff rendered with the same colors as OpenCode's diff viewer. */
function DiffPane(props: {
  theme: PreviewTheme
  change: () => FileChange
  filetype: () => string | undefined
}) {
  const theme = props.theme
  const syntaxStyle = buildSyntaxStyle(theme, usePlugin().renderer.nativeScene)
  onCleanup(() => releaseSyntaxStyle(syntaxStyle))
  return (
    <diff
      diff={props.change().patch}
      view="split"
      syncScroll={true}
      filetype={props.filetype()}
      syntaxStyle={syntaxStyle}
      showLineNumbers={true}
      wrapMode="char"
      fg={theme.text.base}
      addedBg={theme.diff.background.added}
      removedBg={theme.diff.background.removed}
      contextBg={theme.diff.background.context}
      addedSignColor={theme.diff.highlight.added}
      removedSignColor={theme.diff.highlight.removed}
      lineNumberFg={theme.diff.lineNumber.text}
      lineNumberBg={theme.diff.background.context}
      addedLineNumberBg={theme.diff.lineNumber.background.added}
      removedLineNumberBg={theme.diff.lineNumber.background.removed}
    />
  )
}

function MessagePane(props: { theme: PreviewTheme; label: () => string }) {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center" rowGap={1}>
      <text fg={props.theme.text.action.primary.base} attributes={TextAttributes.BOLD}>
        ◇
      </text>
      <text fg={props.theme.text.muted}>{props.label()}</text>
    </box>
  )
}

/**
 * VSCode-style file preview: tab bar with git status, highlighted editor with
 * line numbers, side-by-side working-tree diff, and a status bar. The dialog frame
 * sizes itself from its content, so the root box owns an explicit height.
 */
function FilePreviewDialog(props: { preview: () => FilePreview | undefined }) {
  const context = usePlugin()
  const theme = context.theme.surface("dialog") as PreviewTheme
  const dimensions = useTerminalDimensions()

  // Apply presentation to the mounted dialog, after show() initializes it.
  onMount(() => context.ui.dialog.set({ size: "xlarge", centered: true }))

  const current = props.preview

  const readyPreview = createMemo(() => {
    const preview = current()
    return preview && preview.status === "ready" ? preview : undefined
  })

  const [searchOpen, setSearchOpen] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [matchIndex, setMatchIndex] = createSignal(0)
  const [showGitDiff, setShowGitDiff] = createSignal(false)
  const [menu, setMenu] = createSignal<{ left: number; top: number; text: string }>()
  const [menuHover, setMenuHover] = createSignal(false)
  let dialogRoot: BoxRenderable | undefined
  let searchInput: InputRenderable | undefined
  let codeScroll: ScrollBoxRenderable | undefined
  let diffScroll: ScrollBoxRenderable | undefined

  createEffect(() => {
    if (!showGitDiff()) return
    const width = dimensions().width
    const frame = dialogRoot?.parent
    if (!isRenderable(frame) || frame.isDestroyed) return

    // The host's largest preset is capped at 116 columns and its dialog API
    // has no custom width. Expand the containing frame, not just its child,
    // so centering and mouse hit areas follow the wider split view too.
    frame.minWidth = Math.max(1, width - 4)
    onCleanup(() => {
      if (!frame.isDestroyed) frame.minWidth = undefined
    })
  })

  const dismissMenu = () => {
    setMenu(undefined)
    setMenuHover(false)
  }

  /** Opens the selection menu next to the cursor, clamped inside the dialog. */
  const openSelectionMenu = (x: number, y: number, text: string) => {
    const root = dialogRoot
    const localX = x - (root && !root.isDestroyed ? Math.trunc(root.x) : 0) - 1
    const localY = y - (root && !root.isDestroyed ? Math.trunc(root.y) : 0) - 1
    const maxLeft = root && !root.isDestroyed ? Math.trunc(root.width) - SELECTION_MENU_WIDTH - 2 : localX
    const maxTop = root && !root.isDestroyed ? Math.trunc(root.height) - SELECTION_MENU_HEIGHT - 2 : localY
    setMenuHover(false)
    setMenu({
      left: Math.max(0, Math.min(localX, maxLeft)),
      top: Math.max(0, Math.min(localY, maxTop)),
      text,
    })
  }

  /** Sends the selection to the chat composer as absolute path + fenced code. */
  const addSelectionToChat = (text: string) => {
    const preview = current()
    dismissMenu()
    if (!preview) return

    const body = text.replace(/\s+$/, "")
    const language = filetype() ?? ""
    const payload = `${preview.node.path}\n\n\`\`\`${language}\n${body}\n\`\`\`\n`
    if (appendToComposer(context.renderer, payload)) {
      context.ui.dialog.clear()
      if (composerEditor && !composerEditor.isDestroyed) composerEditor.focus()
      context.renderer.requestRender()
      context.ui.toast.show({
        title: "Added to chat",
        message: `${countLines(body)} line${countLines(body) === 1 ? "" : "s"} from ${preview.node.name}`,
        variant: "success",
        duration: 2000,
      })
      return
    }

    void copyToClipboard(payload).then(
      () => context.ui.toast.show({
        title: "Composer unavailable",
        message: "Selection copied to clipboard — paste it into the chat.",
        variant: "warning",
      }),
      (cause) => context.ui.toast.show({
        title: "Copy failed",
        message: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      }),
    )
  }

  const focusSearch = () => {
    dismissMenu()
    setShowGitDiff(false)
    setSearchOpen(true)
    if (searchInput && !searchInput.isDestroyed) searchInput.focus()
  }

  const closeSearch = () => {
    searchInput?.blur()
    setSearchOpen(false)
    if (showGitDiff()) diffScroll?.focus()
    else codeScroll?.focus()
  }

  const toggleGitDiff = () => {
    dismissMenu()
    searchInput?.blur()
    setSearchOpen(false)
    setShowGitDiff((value) => !value)
  }

  const searchMatches = createMemo(() => findSearchMatches(readyPreview()?.content ?? "", searchQuery()))
  const activeMatch = createMemo(() => searchMatches()[matchIndex()])
  const moveMatch = (direction: number) => {
    const count = searchMatches().length
    if (count) setMatchIndex((index) => (index + direction + count) % count)
  }

  // Dialog-owned keymap takes precedence over session.first (also Ctrl+G).
  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { bind: "ctrl+f", run: focusSearch },
      { bind: "ctrl+g", run: toggleGitDiff },
      { bind: "return", enabled: searchOpen, run: () => moveMatch(1) },
      { bind: "shift+return", enabled: searchOpen, run: () => moveMatch(-1) },
      { bind: "escape", enabled: () => Boolean(menu()), run: dismissMenu },
      { bind: "escape", enabled: () => searchOpen() && !menu(), run: closeSearch },
    ],
  }))

  // Let the host center the dialog; reserve most of the terminal for the file
  // while keeping a small outer margin, including on short terminals.
  const contentHeight = createMemo(() => {
    const height = dimensions().height
    return Math.max(1, Math.min(height - 4, Math.max(14, Math.floor(height * 0.85))))
  })
  const filetype = createMemo(() => pathToFiletype(current()?.node.path ?? ""))
  const linesLabel = createMemo(() => {
    const preview = readyPreview()
    return preview ? `${countLines(preview.content)} lines` : ""
  })
  const eolLabel = createMemo(() => {
    const preview = readyPreview()
    return preview ? detectEol(preview.content) : ""
  })
  const breadcrumb = createMemo(() => {
    const relative = current()?.relativePath ?? ""
    const index = relative.lastIndexOf("/")
    return index === -1 ? "" : relative.slice(0, index)
  })
  const comparisonLabel = createMemo(() => {
    const branch = current()?.branch
    return `working tree${branch ? ` · ${branch}` : ""}`
  })

  const statusLabel = () => {
    if (readyPreview()?.gitMessage) return "git unavailable"
    const change = readyPreview()?.change
    if (!change) return "clean"
    if (change.status === "added") return "added"
    if (change.status === "deleted") return "deleted"
    return "modified"
  }

  const statusColor = () => {
    const change = readyPreview()?.change
    if (!change) return theme.text.muted
    if (change.status === "added") return theme.diff.text.added
    if (change.status === "deleted") return theme.diff.text.removed
    return theme.text.feedback.warning.base
  }
  const statusGlyph = () => {
    const change = readyPreview()?.change
    if (!change) return "·"
    return change.status === "added" ? "A" : change.status === "deleted" ? "D" : "M"
  }

  const messageLabel = () => {
    const preview = current()
    switch (preview?.status) {
      case "loading":
        return "Loading file..."
      case "binary":
        return "Binary file — preview unavailable"
      case "too-large":
        return `File too large to preview (${formatBytes(preview.sizeBytes)})`
      case "error":
        return preview.message ?? "Unable to open file"
      default:
        return ""
    }
  }

  return (
    <box
      ref={dialogRoot}
      flexDirection="column"
      width="100%"
      height={contentHeight()}
      backgroundColor={theme.background.base}
      border={true}
      borderStyle="rounded"
      borderColor={theme.background.raised.high}
    >
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        columnGap={1}
        backgroundColor={theme.background.raised.max}
      >
        <text fg={theme.text.action.primary.base} flexShrink={0}>
          ●
        </text>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
          {current()?.node.name ?? ""}
        </text>
        <Show when={readyPreview()}>
          <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
            <text fg={statusColor()} attributes={TextAttributes.BOLD}>
              {statusGlyph()} {statusLabel()}
            </text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0} />
        <box
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          backgroundColor={showGitDiff() ? theme.text.action.primary.base : theme.background.raised.high}
          onMouseUp={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            toggleGitDiff()
          }}
        >
          <text fg={showGitDiff() ? theme.background.base : theme.text.base}>
            {showGitDiff() ? "[x] Git diff" : "[ ] Git diff"}
          </text>
        </box>
        <text fg={theme.text.muted} flexShrink={0}>
          File preview
        </text>
      </box>

      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        paddingLeft={2}
        paddingRight={1}
        columnGap={1}
        backgroundColor={theme.background.raised.base}
      >
        <text fg={theme.text.muted} truncate flexGrow={1} minWidth={0}>
          {current()?.relativePath ?? breadcrumb()}
        </text>
        <Show when={linesLabel()}>
          <text fg={theme.text.muted} flexShrink={0}>
            {linesLabel()}
          </text>
        </Show>
      </box>

      <Show when={searchOpen()}>
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          columnGap={1}
          backgroundColor={theme.background.raised.base}
        >
          <text fg={theme.text.action.primary.base} flexShrink={0}>
            /
          </text>
          <input
            ref={searchInput}
            value={searchQuery()}
            placeholder="Search in file..."
            placeholderColor={theme.text.muted}
            backgroundColor={theme.background.raised.high}
            focusedBackgroundColor={theme.background.raised.high}
            textColor={theme.text.base}
            focusedTextColor={theme.text.base}
            flexGrow={1}
            minWidth={0}
            onInput={(value) => {
              setMatchIndex(0)
              setSearchQuery(value)
            }}
            focused
          />
          <text fg={theme.text.muted} flexShrink={0}>
            {searchQuery().trim() ? `${searchMatches().length ? matchIndex() + 1 : 0}/${searchMatches().length}` : "type to search"}
          </text>
          <text fg={theme.text.muted} flexShrink={0}>
            Enter next · Shift+Enter prev · Esc
          </text>
        </box>
      </Show>

      <Show
        when={showGitDiff()}
        fallback={
          <Show when={readyPreview()} keyed fallback={<MessagePane theme={theme} label={messageLabel} />}>
            {(preview) => (
              <scrollbox
                ref={codeScroll}
                flexGrow={1}
                minHeight={0}
                focused={!searchOpen()}
                scrollX
                paddingLeft={1}
                paddingRight={1}
              >
                <CodePane
                  theme={theme}
                  content={() => preview.content}
                  filetype={() => filetype()}
                  searchQuery={searchQuery}
                  activeMatch={activeMatch}
                  scroll={() => codeScroll}
                  onContextMenu={openSelectionMenu}
                  onDismissMenu={dismissMenu}
                />
              </scrollbox>
            )}
          </Show>
        }
      >
        <Show
          when={readyPreview()?.change}
          fallback={
            <MessagePane
              theme={theme}
              label={() => readyPreview()
                ? readyPreview()?.gitMessage ?? "No uncommitted changes in this file"
                : messageLabel()}
            />
          }
        >
          {(change) => (
            <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                columnGap={1}
                backgroundColor={theme.background.raised.max}
              >
                <text fg={theme.text.action.primary.base} attributes={TextAttributes.BOLD} flexShrink={0}>
                  Git diff
                </text>
                <text fg={theme.diff.text.added} flexShrink={0}>
                  +{change().additions}
                </text>
                <text fg={theme.diff.text.removed} flexShrink={0}>
                  -{change().deletions}
                </text>
                <text fg={theme.text.muted} truncate flexGrow={1} minWidth={0}>
                  {comparisonLabel()}
                </text>
              </box>
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.background.raised.base}
              >
                <box width="50%" paddingLeft={1}>
                  <text fg={theme.diff.text.removed} truncate>HEAD · before</text>
                </box>
                <box width="50%" paddingLeft={1}>
                  <text fg={theme.diff.text.added} truncate>Working tree · after</text>
                </box>
              </box>
              <scrollbox
                ref={diffScroll}
                flexGrow={1}
                minHeight={0}
                focused
                paddingLeft={1}
                paddingRight={1}
              >
                <DiffPane theme={theme} change={() => change()} filetype={() => filetype()} />
              </scrollbox>
            </box>
          )}
        </Show>
      </Show>

      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        columnGap={1}
        backgroundColor={theme.background.raised.max}
      >
        <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Esc
          </text>
          <text fg={theme.text.muted}> close</text>
        </box>
        <Show when={current()?.branch}>
          {(branch) => (
            <text fg={theme.text.muted} flexShrink={0}>
              git: {branch()}
            </text>
          )}
        </Show>
        <text fg={theme.text.muted} flexShrink={0}>
          Ctrl+F search
        </text>
        <text fg={theme.text.muted} flexShrink={0}>
          Ctrl+G {showGitDiff() ? "file" : "git diff"}
        </text>
        <text fg={theme.text.muted} truncate flexShrink={1} minWidth={0}>
          drag-select · right-click chat
        </text>
        <box flexGrow={1} minWidth={0} />
        <Show when={readyPreview()}>
          <text fg={theme.text.muted} flexShrink={0}>
            {eolLabel()}
          </text>
          <text fg={theme.text.muted} flexShrink={0}>
            UTF-8
          </text>
          <text fg={theme.text.muted} flexShrink={0}>
            {formatBytes(current()?.sizeBytes ?? 0)}
          </text>
          <text fg={theme.text.muted} flexShrink={0}>
            {linesLabel()}
          </text>
        </Show>
        <text fg={theme.text.muted} flexShrink={0}>
          {languageName(filetype())}
        </text>
      </box>

      <Show when={menu()}>
        {(item) => {
          const lines = countLines(item().text)
          const choose = (event: TuiMouseEvent) => {
            if (event.button !== 0) return
            event.stopPropagation()
            addSelectionToChat(item().text)
          }
          return (
            <box
              position="absolute"
              left={item().left}
              top={item().top}
              width={SELECTION_MENU_WIDTH}
              height={SELECTION_MENU_HEIGHT}
              zIndex={10}
              flexDirection="column"
              backgroundColor={menuHover() ? theme.background.raised.high : theme.background.raised.max}
              border={true}
              borderStyle="rounded"
              borderColor={menuHover() ? theme.text.action.primary.base : theme.background.raised.high}
              onMouseUp={choose}
              onMouseOver={() => setMenuHover(true)}
              onMouseOut={() => setMenuHover(false)}
            >
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                columnGap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.text.action.primary.base}
              >
                <text fg={theme.background.base} attributes={TextAttributes.BOLD}>
                  +
                </text>
                <text fg={theme.background.base} attributes={TextAttributes.BOLD} truncate>
                  Add to chat
                </text>
              </box>
              <text fg={theme.text.muted} truncate paddingLeft={2}>
                {lines} line{lines === 1 ? "" : "s"} · path + code
              </text>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// File tree panel
// ---------------------------------------------------------------------------

function FileTreePanel() {
  const context = usePlugin()
  // Reactive accessor — the sidebar lives for the whole session and must
  // follow theme switches; `context.theme` is a reactive getter on the host.
  const theme = () => context.theme as PreviewTheme
  const location = context.location ?? context.data.location.default()
  const root = path.resolve(location?.directory ?? process.cwd())
  const dimensions = useTerminalDimensions()

  const [rootEntries, setRootEntries] = createSignal<FileNode[]>([])
  const [revision, setRevision] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [preview, setPreview] = createSignal<FilePreview>()
  const loaded = new Map<string, FileNode[]>()
  const expanded = new Set<string>()
  let treeVersion = 0
  let lastClick: { path: string; time: number } = { path: "", time: 0 }
  let pendingOpen: FileNode | undefined
  let openToken = 0

  const loadDirectory = async (directory: string, depth: number): Promise<FileNode[]> => {
    const version = treeVersion
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

    if (version === treeVersion) loaded.set(directory, nodes)
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

  // Rows the sidebar viewport can actually show: terminal height minus the
  // chrome rows, clamped so tiny terminals still show a few entries and huge
  // terminals never exceed the hard ceiling.
  const visibleRows = createMemo(() => {
    const available = dimensions().height - RESERVED_ROWS
    return Math.max(MIN_ROWS, Math.min(MAX_ROWS, available))
  })

  const displayed = createMemo(() => {
    const rows = visible()
    const index = selected()
    const count = visibleRows()
    const start = Math.max(0, Math.min(index - Math.floor(count / 2), rows.length - count))
    return rows.slice(start, start + count).map((node, offset) => ({
      node,
      index: start + offset,
    }))
  })

  const refresh = async () => {
    treeVersion++
    pendingOpen = undefined
    lastClick = { path: "", time: 0 }
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
    const version = treeVersion
    if (expanded.has(node.path)) {
      expanded.delete(node.path)
    } else {
      try {
        await loadDirectory(node.path, node.depth + 1)
        if (version !== treeVersion) return
        expanded.add(node.path)
      } catch (cause) {
        if (version !== treeVersion) return
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
      const fileChange = changes.data.find((change) => {
        const changePath = normalizeGitPath(change.file)
        const normalizedChangePath = process.platform === "win32" ? changePath.toLowerCase() : changePath
        return normalizedChangePath === comparisonPath || normalizedChangePath.endsWith(`/${comparisonPath}`)
      })

      if (fileChange) {
        return {
          branch: vcs.data.branch.current ?? vcs.data.branch.default,
          change: fileChange as FileChange,
          gitMessage: undefined,
        }
      }
    } catch {
      // The service may not have detected this local repository yet.
    }

    try {
      return { ...await loadLocalGitInfo(filePath), gitMessage: undefined }
    } catch (cause) {
      return {
        branch: undefined,
        change: undefined,
        gitMessage: `Unable to read Git changes: ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
  }

  const openFile = async (node: FileNode) => {
    if (node.directory) return
    const token = ++openToken
    const stale = () => token !== openToken
    const relativePath = normalizeGitPath(path.relative(root, node.path))

    ensureRemoteParsers()
    captureComposer(context.renderer)
    setPreview({ node, status: "loading", content: "", sizeBytes: 0, relativePath })
    context.ui.dialog.show(
      () => <FilePreviewDialog preview={preview} />,
      () => {
        if (!stale()) setPreview(undefined)
      },
    )

    try {
      const [fileStats, git] = await Promise.all([stat(node.path), loadGitInfo(node.path)])
      if (stale()) return

      if (fileStats.size > MAX_FILE_SIZE) {
        setPreview({ node, status: "too-large", content: "", sizeBytes: fileStats.size, relativePath })
        return
      }

      const content = await readFile(node.path, "utf8")
      if (stale()) return

      if (isBinaryContent(content)) {
        setPreview({ node, status: "binary", content: "", sizeBytes: fileStats.size, relativePath })
        return
      }

      setPreview({
        node,
        status: "ready",
        content,
        sizeBytes: fileStats.size,
        relativePath,
        branch: git?.branch,
        change: git?.change,
        gitMessage: git?.gitMessage,
      })
    } catch (cause) {
      if (stale()) return
      setPreview({
        node,
        status: "error",
        content: "",
        sizeBytes: 0,
        relativePath,
        message: cause instanceof Error ? cause.message : String(cause),
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
    pendingOpen = undefined
    if (node.directory) {
      void toggleDirectory(node)
      return
    }

    const now = Date.now()
    const isDoubleClick = lastClick.path === node.path && now - lastClick.time <= DOUBLE_CLICK_DELAY
    lastClick = { path: node.path, time: now }
    if (isDoubleClick) pendingOpen = node
  }

  const handleNodeMouseUp = (event: TuiMouseEvent, item: { node: FileNode; index: number }) => {
    if (event.button !== 0 || pendingOpen?.path !== item.node.path) return
    pendingOpen = undefined
    void openFile(item.node)
  }

  onMount(() => void refresh())

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={theme().text.muted} flexShrink={0}>Files</text>
        <box flexGrow={1} minWidth={0} />
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme().background.raised.high}
          onMouseUp={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            if (!loading()) void refresh()
          }}
        >
          <text fg={loading() ? theme().text.muted : theme().text.action.primary.base}>
            {loading() ? "Refreshing..." : "Refresh"}
          </text>
        </box>
      </box>
      <text fg={theme().text.base} truncate>
        {root}
      </text>
      <Show when={!loading()} fallback={<text fg={theme().text.muted}>Loading...</text>}>
        <Show when={!error()} fallback={<text fg={theme().text.feedback.error.base} truncate>{error()}</text>}>
          <For each={displayed()}>
            {(item) => {
              const active = () => item.index === selected()
              const marker = () => (item.node.directory ? (expanded.has(item.node.path) ? "▾ " : "▸ ") : "  ")
              return (
                <box
                  flexDirection="row"
                  onMouseDown={(event) => handleNodeMouseDown(event, item)}
                  onMouseUp={(event) => handleNodeMouseUp(event, item)}
                >
                  <text fg={active() ? theme().text.action.primary.base : theme().text.base} truncate>
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
      <text fg={theme().text.muted} truncate>
        Double-click view · right-click copy
      </text>
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
