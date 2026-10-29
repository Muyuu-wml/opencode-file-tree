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

/**
 * Rebases a repository-root-relative path onto the tree root. Returns `""`
 * when the path is outside the tree root (caller keeps or drops it).
 */
function fileToTreeRoot(file: string, prefix: string): string {
  if (!prefix) return file
  return file.startsWith(prefix) ? file.slice(prefix.length) : ""
}

/**
 * One `git status` call for the whole repository, keyed by repo-relative POSIX
 * path. Untracked files are expanded with `--untracked-files=all` so tree rows
 * can be colored individually. Returns an empty map outside a repository.
 */
export async function loadGitStatusSnapshot(root: string): Promise<Map<string, GitStatus>> {
  try {
    // Porcelain paths are relative to the repository root. When the tree is
    // rooted in a subdirectory, only entries under it are kept and their keys
    // are rebased to the tree root, so row lookups never collide.
    const shownRoot = (await exec("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      cwd: root, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    })).stdout.trim()
    const shownRelative = path.relative(shownRoot, root).replaceAll("\\", "/")
    const prefix = shownRelative && shownRelative !== "." ? `${shownRelative}/` : ""

    const { stdout } = await exec("git", ["-C", root, "--literal-pathspecs", "status", "--porcelain=v1", "--untracked-files=all", "-z"], {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })

    const map = new Map<string, GitStatus>()
    const entries = stdout.split("\0").filter(Boolean)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (entry.length < 4) continue
      const x = entry[0]
      const y = entry[1]
      const file = entry.slice(3)

      const key = prefix ? fileToTreeRoot(file, prefix) : file
      if (key === "") continue

      if (x === "?" && y === "?") {
        map.set(key.replaceAll("\\", "/"), "untracked")
        continue
      }
      if (x === "!" && y === "!") continue

      const status = statusFromIndexLetter(x) ?? statusFromIndexLetter(y) ?? (x === "U" || y === "U" ? "modified" : undefined)
      if (!status) continue
      map.set(key.replaceAll("\\", "/"), status)
      // Renames and copies from porcelain carry the original path right after.
      const isRename = x === "R" || x === "C" || y === "R" || y === "C"
      if (isRename && index + 1 < entries.length) {
        const original = fileToTreeRoot(entries[index + 1], prefix)
        if (original !== "") map.set(original.replaceAll("\\", "/"), status)
        index++
      }
    }
    return map
  } catch {
    return new Map()
  }
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
