/**
 * FORK: Embedded plugin loader
 *
 * This module loads plugins that were bundled into the binary at build time.
 * It reads configuration from opencode.jsonc to:
 * - Disable specific embedded plugins (set to false)
 * - Override plugin options
 *
 * Configuration format in opencode.jsonc:
 * {
 *   "plugin": [
 *     ["embedded:loop-guard", { "doom_loop_threshold": 5 }],  // with options
 *     ["embedded:compaction-todo", false],                    // disabled
 *     "embedded:subagent-mandatory-instruction"               // default options
 *   ]
 * }
 *
 * Plugins not listed in config are loaded with default options.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Type for the generated module
type EmbeddedPlugin = {
  name: string
  plugin: (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>
}

// Type for config entries
type PluginSpec = string | [string, Record<string, unknown> | false]

// Lazy-loaded reference to embedded plugins module
let pluginsPromise: Promise<EmbeddedPlugin[]> | undefined

async function getEmbeddedPlugins(): Promise<EmbeddedPlugin[]> {
  if (!pluginsPromise) {
    pluginsPromise = (async () => {
      try {
        // @ts-expect-error - generated file at build time, may not exist during development
        const mod = await import("embedded-plugins.gen.ts")
        return (mod.plugins as EmbeddedPlugin[]) ?? []
      } catch {
        // This is expected when running from source (not compiled binary)
        // or when no plugins were embedded
        return []
      }
    })()
  }
  return pluginsPromise
}

type PluginConfig = {
  enabled: boolean
  options?: Record<string, unknown>
}

/**
 * Parse plugin configuration from the config array.
 *
 * @param pluginArray - The "plugin" array from opencode.jsonc
 * @param name - The embedded plugin name (e.g., "loop-guard")
 * @returns Configuration for the plugin
 */
function parsePluginConfig(pluginArray: PluginSpec[] | undefined, name: string): PluginConfig {
  const prefix = `embedded:${name}`

  // If no config array, use defaults (enabled, no custom options)
  if (!pluginArray || !Array.isArray(pluginArray)) {
    return { enabled: true }
  }

  for (const entry of pluginArray) {
    // String entry: "embedded:name"
    if (typeof entry === "string") {
      if (entry === prefix) {
        return { enabled: true }
      }
      continue
    }

    // Array entry: ["embedded:name", options | false]
    if (Array.isArray(entry) && entry[0] === prefix) {
      const opts = entry[1]

      // Explicitly disabled
      if (opts === false) {
        return { enabled: false }
      }

      // Custom options
      if (opts && typeof opts === "object") {
        return { enabled: true, options: opts as Record<string, unknown> }
      }

      return { enabled: true }
    }
  }

  // Not found in config, use defaults (enabled)
  return { enabled: true }
}

/**
 * Load all embedded plugins that are enabled in the configuration.
 *
 * @param cfg - The opencode configuration object
 * @param input - Plugin input (client, project, etc.)
 * @returns Array of initialized plugin hooks
 */
export async function loadEmbedded(cfg: { plugin?: PluginSpec[] }, input: PluginInput): Promise<Hooks[]> {
  const plugins = await getEmbeddedPlugins()

  if (plugins.length === 0) {
    return []
  }

  const hooks: Hooks[] = []

  for (const { name, plugin } of plugins) {
    const config = parsePluginConfig(cfg.plugin, name)

    if (!config.enabled) {
      // Plugin explicitly disabled in config
      continue
    }

    try {
      const hook = await plugin(input, config.options)
      hooks.push(hook)
    } catch (err) {
      // Log error but don't fail - other plugins should still load
      console.error(`[embedded] Failed to load plugin "${name}":`, err)
    }
  }

  return hooks
}
