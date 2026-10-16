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
