export * as ConfigObjectives from "./objectives.js"

import { Schema } from "effect"
import { NonNegativeInt, optional, PositiveInt } from "../schema.js"

const UnitScore = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const PercentThreshold = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const CompactionPercentThreshold = Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 99 }))

export class Info extends Schema.Class<Info>("Config.Objectives")({
  max_actions_without_sync: PositiveInt.pipe(optional).annotate({
    description:
      "Maximum consecutive tool operations (reads, searches, commands, edits) allowed without synchronizing the objective tree via objective_manage before emitting [Objective Sync Warning] (default: 15).",
  }),
  repeated_action_warning_threshold: PositiveInt.pipe(optional).annotate({
    description:
      "Number of identical normalized read calls on the same active Secondary Objective before emitting a repeated-action warning (default: 2).",
  }),
  search_attach_threshold: UnitScore.pipe(optional).annotate({
    description:
      "Similarity score threshold (0.0-1.0) at or above which add_finding rejects a duplicate finding and requires update_finding (default: 0.68).",
  }),
  search_novel_threshold: UnitScore.pipe(optional).annotate({
    description:
      "Similarity score threshold (0.0-1.0) at or above which add_finding emits a similarity warning and links seeAlso (default: 0.55).",
  }),
  finding_min_chars: PositiveInt.pipe(optional).annotate({
    description:
      "Minimum character length required for finding title, result, and nextAction anti-placeholder validation (default: 15).",
  }),
  delegation_justification_min_chars: PositiveInt.pipe(optional).annotate({
    description:
      "Minimum character length required for delegation.justification when assigning main or subagent execution (default: 10).",
  }),
  fresh_session_percent_threshold: PercentThreshold.pipe(optional).annotate({
    description:
      "Context usage percentage (1-100) during planning at or above which present_plan recommends launching execution in a Fresh Session (default: 35).",
  }),
  fresh_session_tokens_threshold: PositiveInt.pipe(optional).annotate({
    description:
      "Context tokens consumed during planning at or above which present_plan recommends launching execution in a Fresh Session (default: 30000).",
  }),
  relevance_cooldown_ms: NonNegativeInt.pipe(optional).annotate({
    description:
      "Cooldown in milliseconds between isolated one-shot documentation relevance evaluations on llama.cpp slot 1 (default: 3000).",
  }),
  primary_pre_compaction_threshold: CompactionPercentThreshold.pipe(optional).annotate({
    description:
      "Context ceiling percentage (50-99) at which the primary session receives CRITICAL PRE-COMPACTION ADVISORY to consolidate objectives and call session_compact (default: 85).",
  }),
  subagent_pre_compaction_threshold: CompactionPercentThreshold.pipe(optional).annotate({
    description:
      "Context ceiling percentage (50-99) at which a subagent receives CRITICAL PRE-COMPACTION ADVISORY to halt exploration and return <OUTPUT> (default: 90).",
  }),
  min_subagent_budget: PositiveInt.pipe(optional).annotate({
    description:
      "Minimum available token headroom required in context_budget to allow subagent delegation and minimum safety reserve floor (default: 16000).",
  }),
  embeddings_enabled: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether semantic embeddings via local LM Studio are enabled for add_finding and search_findings before falling back to lexical scoring (default: true).",
  }),
  unattended: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether unattended mode is enabled by default so presented plans auto-approve without freezing in presented_awaiting_confirmation (default: false).",
  }),
  llamacpp_kv_offload: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether llama.cpp KV cache offload to disk is enabled when running with parallel=2 to allow safe subagent execution without VRAM exhaustion (default: true).",
  }),
  llamacpp_slot_save_path: Schema.String.pipe(optional).annotate({
    description:
      "Optional directory path where llama-server saves and restores slot KV cache snapshots. If omitted or empty, llama-server uses its default slot_save_path or system temp.",
  }),
  subagent_model: Schema.String.pipe(optional).annotate({
    description:
      "Model identifier override to use when spawning child subagents. If omitted or empty, subagents default to the parent session's model.",
  }),
}) {}

export const Patch = Schema.Struct({
  max_actions_without_sync: Schema.NullOr(PositiveInt).pipe(optional),
  repeated_action_warning_threshold: Schema.NullOr(PositiveInt).pipe(optional),
  search_attach_threshold: Schema.NullOr(UnitScore).pipe(optional),
  search_novel_threshold: Schema.NullOr(UnitScore).pipe(optional),
  finding_min_chars: Schema.NullOr(PositiveInt).pipe(optional),
  delegation_justification_min_chars: Schema.NullOr(PositiveInt).pipe(optional),
  fresh_session_percent_threshold: Schema.NullOr(PercentThreshold).pipe(optional),
  fresh_session_tokens_threshold: Schema.NullOr(PositiveInt).pipe(optional),
  relevance_cooldown_ms: Schema.NullOr(NonNegativeInt).pipe(optional),
  primary_pre_compaction_threshold: Schema.NullOr(CompactionPercentThreshold).pipe(optional),
  subagent_pre_compaction_threshold: Schema.NullOr(CompactionPercentThreshold).pipe(optional),
  min_subagent_budget: Schema.NullOr(PositiveInt).pipe(optional),
  embeddings_enabled: Schema.NullOr(Schema.Boolean).pipe(optional),
  unattended: Schema.NullOr(Schema.Boolean).pipe(optional),
  llamacpp_kv_offload: Schema.NullOr(Schema.Boolean).pipe(optional),
  llamacpp_slot_save_path: Schema.NullOr(Schema.String).pipe(optional),
  subagent_model: Schema.NullOr(Schema.String).pipe(optional),
}).annotate({ identifier: "Config.Objectives.Patch" })
export type Patch = typeof Patch.Type
