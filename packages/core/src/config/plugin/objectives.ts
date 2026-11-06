export * as ConfigObjectivesPlugin from "./objectives.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { Effect } from "effect"
import { Config } from "../../config.js"
import {
  normalizeObjectivesConfigInput,
  setGlobalObjectivesConfig,
  type ObjectivesProtocolConfig,
} from "../../plugin/builtin/objectives-model.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.objectives",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const sync = (entries: readonly Entry[]) => {
      let merged: Partial<ObjectivesProtocolConfig> = {}
      for (const entry of entries) {
        if (entry.type !== "document" || !entry.info.objectives) continue
        merged = { ...merged, ...normalizeObjectivesConfigInput(entry.info.objectives) }
      }
      setGlobalObjectivesConfig(merged)
    }
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      Effect.gen(function* () {
        sync(yield* config.entries())
      }),
    )
    sync(loaded.entries)
  }),
})
