#!/usr/bin/env bun
// Verifies cross-surface feature parity and shared-contract discipline between TUI and Web/Desktop.
// Usage:
//   bun script/check-surface-parity.ts
import path from "node:path"
import { SLASH_COMMAND_PARITY, SHARED_SERVER_SETTINGS } from "../packages/schema/src/surface-parity.ts"
import { ConfigObjectives } from "../packages/schema/src/config/objectives.ts"

const ROOT = path.resolve(import.meta.dir, "..")

const errors: string[] = []

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

async function scanFiles(pattern: string) {
  const paths = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: ROOT }))
  return paths.sort()
}

// 1. Collect TUI slash command names & aliases
const tuiSlashNames = new Set<string>()
const tuiFiles = await scanFiles("packages/tui/src/**/*.{ts,tsx}")
for (const file of tuiFiles) {
  const source = stripComments(await Bun.file(path.join(ROOT, file)).text())
  for (const match of source.matchAll(/slash\s*:\s*\{([^}]*)\}/gs)) {
    const body = match[1] ?? ""
    const nameMatch = body.match(/name\s*:\s*["']([^"']+)["']/)
    if (nameMatch?.[1]) tuiSlashNames.add(nameMatch[1])
    const aliasesMatch = body.match(/aliases\s*:\s*\[([^\]]*)\]/s)
    if (aliasesMatch?.[1]) {
      for (const alias of aliasesMatch[1].matchAll(/["']([^"']+)["']/g)) {
        if (alias[1]) tuiSlashNames.add(alias[1])
      }
    }
  }
}

// 2. Collect Web/Desktop (app + gui-plugins) slash command names & aliases
const webSlashNames = new Set<string>()
const webCommandFiles = [
  ...(await scanFiles("packages/app/src/**/*.{ts,tsx}")),
  ...(await scanFiles("packages/gui-plugins/src/**/*.{ts,tsx}")),
]
for (const file of webCommandFiles) {
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".stories.tsx")) continue
  const source = stripComments(await Bun.file(path.join(ROOT, file)).text())
  // Object form: slash: { name: "...", ... } (gui-plugins)
  for (const match of source.matchAll(/slash\s*:\s*\{([^}]*)\}/gs)) {
    const body = match[1] ?? ""
    const nameMatch = body.match(/name\s*:\s*["']([^"']+)["']/)
    if (nameMatch?.[1]) webSlashNames.add(nameMatch[1])
  }
  // String form: slash: "..." plus optional slashAliases: [...]
  for (const match of source.matchAll(/\bslash\s*:\s*["']([a-zA-Z0-9][a-zA-Z0-9._-]*)["']/g)) {
    if (match[1]) webSlashNames.add(match[1])
  }
  for (const match of source.matchAll(/\bslashAliases\s*:\s*\[([^\]]*)\]/gs)) {
    for (const alias of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      if (alias[1]) webSlashNames.add(alias[1])
    }
  }
}

// 3. Collect server-registered command names from core builtin plugins (ctx.command.transform)
const serverCommandNames = new Set<string>()
const corePluginFiles = await scanFiles("packages/core/src/plugin/**/*.ts")
for (const file of corePluginFiles) {
  if (file.endsWith(".test.ts")) continue
  const source = stripComments(await Bun.file(path.join(ROOT, file)).text())
  if (!source.includes("command.transform")) continue
  for (const match of source.matchAll(/editor\.add\(\s*\{\s*name\s*:\s*["']([^"']+)["']/g)) {
    if (match[1]) serverCommandNames.add(match[1])
  }
}

// 4. Validate slash parity manifest against both surfaces
const expectedTuiSlash = new Set<string>()
const expectedWebSlash = new Set<string>()

for (const entry of SLASH_COMMAND_PARITY) {
  const hasTui = entry.surfaces.includes("tui")
  const hasWeb = entry.surfaces.includes("web")
  if (entry.serverRegistered) {
    // Server-backed commands reach both surfaces through command.list; validate
    // the registration exists in a core plugin instead of UI slash registrations.
    for (const name of entry.names) {
      if (!serverCommandNames.has(name)) {
        errors.push(
          `[slash-parity] Server-registered "/${name}" (${entry.id}) is not added via editor.add in any packages/core/src/plugin command.transform.`,
        )
      }
      if (hasTui) expectedTuiSlash.add(name)
      if (hasWeb) expectedWebSlash.add(name)
    }
    continue
  }
  if (hasTui) {
    for (const name of entry.names) {
      expectedTuiSlash.add(name)
      if (!tuiSlashNames.has(name)) {
        errors.push(`[slash-parity] TUI is missing "/${name}" declared in SLASH_COMMAND_PARITY (${entry.id}).`)
      }
    }
  }
  if (hasWeb) {
    for (const name of entry.names) {
      expectedWebSlash.add(name)
      if (!webSlashNames.has(name)) {
        errors.push(`[slash-parity] Web is missing "/${name}" declared in SLASH_COMMAND_PARITY (${entry.id}).`)
      }
    }
  }
}

for (const found of tuiSlashNames) {
  if (!expectedTuiSlash.has(found)) {
    errors.push(`[slash-parity] TUI registers "/${found}" which is absent from SLASH_COMMAND_PARITY (packages/schema/src/surface-parity.ts).`)
  }
}

for (const found of webSlashNames) {
  if (!expectedWebSlash.has(found)) {
    errors.push(`[slash-parity] Web registers "/${found}" which is absent from SLASH_COMMAND_PARITY (packages/schema/src/surface-parity.ts).`)
  }
}

// 5. Validate shared server settings parity
const dialogConfigSource = await Bun.file(path.join(ROOT, "packages/tui/src/component/dialog-config.tsx")).text()
const tuiSettingPaths = new Set<string>()
for (const match of dialogConfigSource.matchAll(/path\s*:\s*\[([^\]]+)\]/g)) {
  const parts = [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
  if (parts.length >= 2) tuiSettingPaths.add(parts.join("."))
}

const webGeneralSource = await Bun.file(path.join(ROOT, "packages/app/src/settings/general/general.tsx")).text()
const webControllersSource = await Bun.file(path.join(ROOT, "packages/app/src/settings/general/controllers.ts")).text()

// Verify all Config.Objectives keys exist in SHARED_SERVER_SETTINGS
for (const key of Object.keys(ConfigObjectives.Info.fields)) {
  const fullPath = `objectives.${key}`
  if (!SHARED_SERVER_SETTINGS.some((entry) => entry.path === fullPath)) {
    errors.push(`[settings-parity] Config.Objectives key "${fullPath}" is missing from SHARED_SERVER_SETTINGS.`)
  }
}

for (const entry of SHARED_SERVER_SETTINGS) {
  if (entry.surfaces.includes("tui") && !tuiSettingPaths.has(entry.path)) {
    errors.push(`[settings-parity] TUI DialogConfig is missing setting "${entry.path}".`)
  }
  if (entry.surfaces.includes("web")) {
    const [, field] = entry.path.split(".")
    if (entry.path === "compaction.model") {
      if (!webGeneralSource.includes("CompactionModelSetting") || !webControllersSource.includes("compaction")) {
        errors.push(`[settings-parity] Web Settings is missing "compaction.model".`)
      }
    } else if (field && (!webGeneralSource.includes(field) && !webControllersSource.includes(field))) {
      errors.push(`[settings-parity] Web Settings is missing "${entry.path}".`)
    } else if (field && entry.path.startsWith("objectives.") && !webGeneralSource.includes(field)) {
      errors.push(`[settings-parity] Web ObjectivesProtocolSection UI is missing "${entry.path}".`)
    }
  }
}

// 6. Enforce no process-local globalThis.__OPENCODE_* or duplicate Rpc.define in UI packages
const uiRoots = [
  "packages/tui/src/**/*.{ts,tsx}",
  "packages/app/src/**/*.{ts,tsx}",
  "packages/gui-plugins/src/**/*.{ts,tsx}",
  "packages/desktop/src/**/*.{ts,tsx}",
]
for (const pattern of uiRoots) {
  const files = await scanFiles(pattern)
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
    const source = stripComments(await Bun.file(path.join(ROOT, file)).text())
    if (source.includes("__OPENCODE_DYNAMIC_CONTEXT__")) {
      errors.push(`[ui-isolation] Forbidden globalThis.__OPENCODE_DYNAMIC_CONTEXT__ reference in ${file}. Use @opencode/schema/dynamic-context RPC + model catalog.`)
    }
    if (/\bRpc\.define\s*\(/.test(source)) {
      errors.push(`[contract-single-source] Forbidden Rpc.define(...) inside UI package ${file}. Move RPC definitions to @opencode/schema.`)
    }
    if (
      /function\s+normalizePrimaryObjectiveView\b/.test(source) &&
      file !== "packages/app/src/session/objectives/model.ts"
    ) {
      errors.push(`[contract-single-source] Duplicate normalizePrimaryObjectiveView definition in ${file}. Import from @opencode/schema/objectives.`)
    }
  }
}

if (errors.length > 0) {
  console.error(`Surface parity check failed with ${errors.length} issue(s):\n`)
  for (const err of errors) console.error(`- ${err}`)
  process.exit(1)
}

console.log(
  `Surface parity OK: ${SLASH_COMMAND_PARITY.length} slash entries, ${SHARED_SERVER_SETTINGS.length} shared settings, 0 UI contract violations.`,
)
