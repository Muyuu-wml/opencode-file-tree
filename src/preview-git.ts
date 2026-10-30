import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export type FileChange = {
  status: "added" | "deleted" | "modified"
  additions: number
  deletions: number
  patch: string
}

export type GitStatus = "added" | "modified" | "deleted" | "renamed" | "untracked"

function statusFromIndexLetter(letter: string): GitStatus | undefined {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  if (letter === "M") return "modified"
  if (letter === "R" || letter === "C") return "renamed"
  if (letter === "T") return "modified"
  return undefined
}

export type GitStatusSnapshot = {
  files: Map<string, GitStatus>
  directories: Map<string, GitStatus>
}

const STATUS_PRIORITY: GitStatus[] = ["deleted", "modified", "added", "renamed", "untracked"]

/**
 * Rebases a repository-root-relative path onto the tree root. Returns `""`
 * when the path is outside the tree root.
 */
function fileToTreeRoot(file: string, prefix: string): string {
  if (!prefix) return file
  const head = file.slice(0, prefix.length)
  const inside = process.platform === "win32" ? head.toLowerCase() === prefix.toLowerCase() : head === prefix
  return inside ? file.slice(prefix.length) : ""
}

/**
 * One `git status` call for the whole repository, keyed by tree-root-relative
 * POSIX path. Untracked files are expanded with `--untracked-files=all` so tree
 * rows can be colored individually. Each directory gets the highest-priority
 * status found under it. Returns empty maps outside a repository.
 */
export async function loadGitStatusSnapshot(root: string): Promise<GitStatusSnapshot> {
  const files = new Map<string, GitStatus>()
  const directories = new Map<string, GitStatus>()
  try {
    const options = { cwd: root, windowsHide: true, encoding: "utf8", timeout: 10_000 } as const
    // Porcelain paths are relative to the repository root; `--show-prefix` is
    // the tree root's position inside it (e.g. "sub/"), or "" at the top level.
    const prefix = (await exec("git", ["rev-parse", "--show-prefix"], options)).stdout.replace(/\r?\n$/, "")
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], {
      ...options,
      maxBuffer: 32 * 1024 * 1024,
    })

    const set = (file: string, status: GitStatus) => {
      const key = fileToTreeRoot(file, prefix)
      if (key) files.set(key, status)
    }
    const entries = stdout.split("\0")
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (entry.length < 4) continue
      const x = entry[0]
      const y = entry[1]
      // Renames and copies carry the original path as the next entry. Consume
      // it before any filtering so it is never parsed as a status entry.
      const original = x === "R" || x === "C" || y === "R" || y === "C" ? entries[++index] : undefined
      if (x === "!" && y === "!") continue

      const status = x === "?" && y === "?"
        ? "untracked"
        : statusFromIndexLetter(x) ?? statusFromIndexLetter(y) ?? (x === "U" || y === "U" ? "modified" : undefined)
      if (!status) continue
      set(entry.slice(3), status)
      if (original) set(original, status)
    }
  } catch {
    return { files, directories }
  }

  // An ancestor never ranks below its descendants, so the walk up can stop at
  // the first directory that already has an equal or higher-priority status.
  for (const [file, status] of files) {
    const rank = STATUS_PRIORITY.indexOf(status)
    for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1)) {
      const directory = file.slice(0, slash)
      const current = directories.get(directory)
      if (current && STATUS_PRIORITY.indexOf(current) <= rank) break
      directories.set(directory, status)
    }
  }
  return { files, directories }
}

export async function loadLocalGitInfo(filePath: string): Promise<{ branch?: string; change?: FileChange }> {
  const cwd = path.dirname(filePath)
  const git = async (args: string[], diffExit = false) => {
    try {
      return (await exec("git", args, { cwd, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout
    } catch (error) {
      // --no-index returns 1 when it successfully finds differences.
      const result = error as { code?: number; stdout?: string }
      if (diffExit && result.code === 1 && typeof result.stdout === "string") return result.stdout
      throw error
    }
  }

  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const relative = path.relative(root, filePath).replaceAll("\\", "/")
  const atRoot = ["-C", root, "--literal-pathspecs"]
  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || undefined
  const files = await git([...atRoot, "ls-files", "--cached", "--others", "--exclude-standard", "--", relative])
  if (!files.trim()) return { branch }

  const hasHead = await git(["rev-parse", "--verify", "HEAD"]).then(() => true, () => false)
  const tracked = (await git([...atRoot, "ls-files", "--cached", "--", relative])).trim()
  const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"]
  const patch = hasHead && tracked
    ? await git([...atRoot, ...options, "HEAD", "--", relative])
    : await git([...atRoot, ...options, "--no-index", "--", "/dev/null", relative], true)
  if (!patch.trim()) return { branch }

  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true
    else if (inHunk && line.startsWith("+")) additions++
    else if (inHunk && line.startsWith("-")) deletions++
  }
  const status = /^new file mode /m.test(patch) ? "added" : /^deleted file mode /m.test(patch) ? "deleted" : "modified"
  return { branch, change: { status, additions, deletions, patch } }
}
