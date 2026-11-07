import { Config, Option } from "effect"
import fs from "node:fs"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

function unwrapOption(value: unknown): unknown {
  if (Option.isOption(value)) return Option.getOrUndefined(value)
  return value
}

function parseJsonOrFileConfig(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return extractObjectivesConfigFromJson(parsed)
    } catch {}
    return {}
  }
  try {
    const content = fs.readFileSync(trimmed, "utf8")
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return extractObjectivesConfigFromJson(parsed)
  } catch {}
  return {}
}

function extractObjectivesConfigFromJson(obj: Record<string, any>): Record<string, unknown> {
  if (obj.metadata?.objectives?.config && typeof obj.metadata.objectives.config === "object") {
    return obj.metadata.objectives.config
  }
  if (obj.metadata?.objectivesConfig && typeof obj.metadata.objectivesConfig === "object") {
    return obj.metadata.objectivesConfig
  }
  if (obj.objectives?.config && typeof obj.objectives.config === "object") {
    return obj.objectives.config
  }
  if (obj.objectives && typeof obj.objectives === "object" && !Array.isArray(obj.objectives)) {
    return obj.objectives
  }
  if (obj.config && typeof obj.config === "object" && !Array.isArray(obj.config)) {
    return obj.config
  }
  return obj
}

export function applyObjectivesCliFlags(input: Record<string, unknown>) {
  const overrides: Record<string, unknown> = {}
  const rawConfig = unwrapOption(input.objectivesConfig)
  if (typeof rawConfig === "string" && rawConfig.trim()) {
    Object.assign(overrides, parseJsonOrFileConfig(rawConfig))
  }

  const flagMap: Array<[string, string]> = [
    ["objectivesMaxActionsWithoutSync", "max_actions_without_sync"],
    ["objectivesRepeatedActionThreshold", "repeated_action_warning_threshold"],
    ["objectivesSearchAttachThreshold", "search_attach_threshold"],
    ["objectivesSearchNovelThreshold", "search_novel_threshold"],
    ["objectivesFindingMinChars", "finding_min_chars"],
    ["objectivesDelegationMinChars", "delegation_justification_min_chars"],
    ["objectivesFreshSessionPercent", "fresh_session_percent_threshold"],
    ["objectivesFreshSessionTokens", "fresh_session_tokens_threshold"],
    ["objectivesRelevanceCooldownMs", "relevance_cooldown_ms"],
    ["objectivesPrimaryCompactionThreshold", "primary_pre_compaction_threshold"],
    ["objectivesSubagentCompactionThreshold", "subagent_pre_compaction_threshold"],
    ["objectivesMinSubagentBudget", "min_subagent_budget"],
    ["objectivesEmbeddings", "embeddings_enabled"],
    ["objectivesUnattended", "unattended"],
    ["objectivesLlamacppKvOffload", "llamacpp_kv_offload"],
    ["objectivesLlamacppSlotSavePath", "llamacpp_slot_save_path"],
    ["objectivesSubagentModel", "subagent_model"],
  ]

  for (const [inputKey, configKey] of flagMap) {
    const val = unwrapOption(input[inputKey])
    if (val !== undefined) {
      overrides[configKey] = val
    }
  }

  if (Object.keys(overrides).length > 0) {
    process.env.OPENCODE_OBJECTIVES_CLI_OVERRIDES = JSON.stringify(overrides)
  }
}

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "OPENCODE_PASSWORD" && entry[0] !== "OPENCODE_SERVER_PASSWORD",
    ),
  )
}

export * as Env from "./env"
