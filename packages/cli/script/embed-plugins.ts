#!/usr/bin/env bun
/**
 * FORK: Generates embedded-plugins.gen.ts content at build time.
 *
 * Reads plugin files from .opencode/plugins/ and generates a module
 * that exports them as an array. This module is then compiled into the
 * binary by Bun.build().
 *
 * The generated code imports each plugin and exports:
 * - plugins: Array of { name, plugin } objects
 *
 * Usage:
 *   bun run script/embed-plugins.ts  # Test generation
 */

import { readFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")
const PLUGINS_DIR = path.join(REPO_ROOT, ".opencode/plugins")

// Plugins to embed (order matters for loading priority)
const EMBEDDED_PLUGINS = ["loop-guard", "compaction-todo", "subagent-mandatory-instruction"]

type PluginExport = {
  name: string
  isDefault: boolean
}

/**
 * Find the plugin export in the file content.
 * Supports:
 * - const FooPlugin: Plugin = ...
 * - export const FooPlugin: Plugin = ...
 * - export default FooPlugin (where FooPlugin is defined with satisfies Plugin)
 */
function findPluginExport(content: string): PluginExport | null {
  // Pattern 1: const Foo: Plugin = ... or export const Foo: Plugin = ...
  const typedMatch = content.match(/(?:export\s+)?const\s+(\w+)\s*:\s*Plugin\s*=/)
  if (typedMatch) {
    // Check if there's also an export default for this name
    const defaultExportMatch = content.match(/export\s+default\s+(\w+)/)
    if (defaultExportMatch && defaultExportMatch[1] === typedMatch[1]) {
      return { name: typedMatch[1], isDefault: true }
    }
    return { name: typedMatch[1], isDefault: false }
  }

  // Pattern 2: export default Foo (look up what Foo is)
  const defaultExportMatch = content.match(/export\s+default\s+(\w+)/)
  if (defaultExportMatch) {
    const exportName = defaultExportMatch[1]
    // Verify this is a Plugin by checking if satisfies Plugin appears after the const
    const constPattern = new RegExp(`const\\s+${exportName}\\s*=`)
    const satisfiesPattern = /satisfies\s+Plugin\s*$/m
    if (constPattern.test(content) && satisfiesPattern.test(content)) {
      return { name: exportName, isDefault: true }
    }
  }

  return null
}

export async function generate(): Promise<string | null> {
  if (!existsSync(PLUGINS_DIR)) {
    console.log("[embed-plugins] No .opencode/plugins/ directory found, skipping")
    return null
  }

  const available: { name: string; file: string; exportName: string; isDefault: boolean }[] = []

  for (const name of EMBEDDED_PLUGINS) {
    const file = path.join(PLUGINS_DIR, `${name}.ts`)
    if (!existsSync(file)) {
      console.log(`[embed-plugins] Plugin ${name}.ts not found, skipping`)
      continue
    }

    // Read file to find the exported plugin name
    const content = await readFile(file, "utf-8")
    const pluginExport = findPluginExport(content)
    if (!pluginExport) {
      console.log(`[embed-plugins] Could not find Plugin export in ${name}.ts, skipping`)
      continue
    }

    available.push({
      name,
      file,
      exportName: pluginExport.name,
      isDefault: pluginExport.isDefault,
    })
  }

  if (available.length === 0) {
    console.log("[embed-plugins] No valid plugins found, skipping")
    return null
  }

  console.log(`[embed-plugins] Embedding ${available.length} plugins: ${available.map((p) => p.name).join(", ")}`)

  // Generate the module content
  const imports = available.map((p, i) => {
    if (p.isDefault) {
      return `import plugin_${i} from ${JSON.stringify(p.file)}`
    }
    return `import { ${p.exportName} as plugin_${i} } from ${JSON.stringify(p.file)}`
  })

  const entries = available.map((p, i) => `  { name: ${JSON.stringify(p.name)}, plugin: plugin_${i} },`)

  return [
    `// Generated at build time by script/embed-plugins.ts`,
    `// Do not edit manually`,
    ``,
    `import type { Plugin } from "@opencode-ai/plugin"`,
    ``,
    ...imports,
    ``,
    `export type EmbeddedPlugin = {`,
    `  name: string`,
    `  plugin: Plugin`,
    `}`,
    ``,
    `export const plugins: EmbeddedPlugin[] = [`,
    ...entries,
    `]`,
  ].join("\n")
}

// Allow running directly for testing
if (import.meta.main) {
  const content = await generate()
  if (content) {
    console.log("\n--- Generated content ---\n")
    console.log(content)
  } else {
    console.log("\n--- No content generated ---")
  }
}
