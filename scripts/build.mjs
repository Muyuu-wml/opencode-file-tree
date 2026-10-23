// Builds the TUI entry for npm.
//
// OpenCode's Bun loader only applies the OpenTUI Solid JSX transform to files
// outside node_modules, so an installed copy of src/tui.tsx is handed to Bun's
// default .tsx loader, which emits a React JSX runtime import and fails with
// "Cannot find package 'react'". Shipping precompiled JS keeps the plugin
// independent of where it is installed.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

const root = path.resolve(import.meta.dirname, "..")
const outDir = path.join(root, "dist")
const sources = ["src/tui.tsx", "src/preview-git.ts", "src/preview-search.ts"]

await mkdir(outDir, { recursive: true })

for (const source of sources) {
  const filename = path.join(root, source)
  const code = await readFile(filename, "utf8")
  const presets = []

  // Same preset options the host uses for local .tsx plugins.
  if (/\.[cm]?[jt]sx$/.test(filename)) {
    presets.push([solid, { moduleName: "@opentui/solid", generate: "universal" }])
  }
  presets.push([typescript])

  const result = await transformAsync(code, {
    filename,
    configFile: false,
    babelrc: false,
    presets,
  })
  if (!result?.code) throw new Error(`No output for ${source}`)
  if (/\bfrom\s*["']react(?:\/|["'])/.test(result.code)) {
    throw new Error(`${source} compiled with the React JSX runtime; the Solid preset did not apply`)
  }

  const output = path.join(outDir, path.basename(source).replace(/\.[cm]?tsx?$/, ".js"))
  await writeFile(output, `${result.code}\n`)
  console.log(`${source} -> ${path.relative(root, output)}`)
}
