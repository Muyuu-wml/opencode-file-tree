export function findSearchMatches(content: string, query: string): Array<[number, number]> {
  const text = query.trim()
  if (!text) return []
  // Match the original string so Unicode case conversion cannot shift offsets.
  const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  return Array.from(content.matchAll(pattern), (match) => [match.index, match.index + match[0].length])
}

export function searchPosition(content: string, offset: number): { line: number; prefix: string } {
  const before = content.slice(0, offset)
  const start = before.lastIndexOf("\n") + 1
  return { line: before.split("\n").length - 1, prefix: before.slice(start) }
}
