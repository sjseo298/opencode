/**
 * Type declarations for the generated embedded-plugins module.
 *
 * The actual module is generated at build time by script/embed-plugins.ts
 * and compiled into the binary. This file provides types for development.
 */

import type { Plugin } from "@opencode-ai/plugin"

export type EmbeddedPlugin = {
  name: string
  plugin: Plugin
}

export declare const plugins: EmbeddedPlugin[]
