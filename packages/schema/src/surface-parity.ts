export * as SurfaceParity from "./surface-parity.js"

export type SurfaceId = "tui" | "web"

export interface SlashParityEntry {
  readonly id: string
  readonly names: readonly string[]
  readonly surfaces: readonly SurfaceId[]
  readonly reason?: string
}

export interface SettingParityEntry {
  readonly path: string
  readonly surfaces: readonly SurfaceId[]
  readonly reason?: string
}

/**
 * Canonical cross-surface feature parity manifest for TUI and Web/Desktop.
 * Every user-facing slash command and server-backed setting must appear here,
 * either targeting both surfaces or declaring an explicit platform exception.
 */
export const SLASH_COMMAND_PARITY: readonly SlashParityEntry[] = [
  // Shared session & workspace commands
  { id: "session.new", names: ["new"], surfaces: ["tui", "web"] },
  { id: "session.switch", names: ["sessions", "resume", "continue"], surfaces: ["tui", "web"] },
  { id: "session.undo", names: ["undo"], surfaces: ["tui", "web"] },
  { id: "session.redo", names: ["redo"], surfaces: ["tui", "web"] },
  { id: "session.rewind", names: ["rewind", "undo-steps", "undosteps", "retry-steps"], surfaces: ["tui", "web"] },
  { id: "session.context.limit", names: ["setContextLimit", "setcontextlimit"], surfaces: ["tui", "web"] },
  { id: "messages.copy", names: ["copy"], surfaces: ["tui", "web"] },
  { id: "session.cd", names: ["cd"], surfaces: ["tui", "web"] },
  { id: "session.rename", names: ["rename"], surfaces: ["tui", "web"] },
  { id: "session.delete", names: ["delete", "session.delete"], surfaces: ["tui", "web"] },
  { id: "session.plan.review", names: ["plan"], surfaces: ["tui", "web"] },
  { id: "session.plan.unapprove", names: ["unapprove"], surfaces: ["tui", "web"] },
  { id: "session.compact", names: ["compact"], surfaces: ["tui", "web"] },
  { id: "session.fork", names: ["fork"], surfaces: ["tui", "web"] },
  { id: "session.export", names: ["export"], surfaces: ["tui", "web"] },
  { id: "session.timeline", names: ["timeline"], surfaces: ["tui", "web"] },
  { id: "session.objectives", names: ["objectives"], surfaces: ["tui", "web"] },
  { id: "file.open", names: ["open", "projects", "project"], surfaces: ["tui", "web"] },
  { id: "mcp.toggle", names: ["mcp", "mcps"], surfaces: ["tui", "web"] },
  {
    id: "permissions.autoaccept",
    names: ["yolo", "autoapprove", "auto-approve", "no-approval", "noapproval", "permissions"],
    surfaces: ["tui", "web"],
  },
  { id: "terminal.toggle", names: ["terminal"], surfaces: ["tui", "web"] },
  { id: "prompt.btw", names: ["btw"], surfaces: ["tui", "web"] },

  // Shared composer, provider, model, and app commands
  { id: "model.choose", names: ["model", "models"], surfaces: ["tui", "web"] },
  { id: "model.variant.choose", names: ["variants", "thinking", "effort"], surfaces: ["tui", "web"] },
  { id: "usage.view", names: ["usage"], surfaces: ["tui", "web"] },
  { id: "provider.connect", names: ["connect"], surfaces: ["tui", "web"] },
  { id: "antigravity.accounts", names: ["antigravity", "ag"], surfaces: ["tui", "web"] },
  { id: "config.reload", names: ["reload"], surfaces: ["tui", "web"] },
  { id: "agent.cycle", names: ["agent", "agents"], surfaces: ["tui", "web"] },
  { id: "settings.open", names: ["settings"], surfaces: ["tui", "web"] },
  { id: "theme.choose", names: ["themes"], surfaces: ["tui", "web"] },

  // Explicit TUI-only platform commands
  { id: "tui.clear", names: ["clear"], surfaces: ["tui"], reason: "Terminal screen clear / return to TUI home" },
  { id: "tui.highlights", names: ["highlights"], surfaces: ["tui"], reason: "TUI release highlights dialog" },
  { id: "tui.status", names: ["status"], surfaces: ["tui"], reason: "CLI/TUI server & environment status modal" },
  { id: "tui.update", names: ["update"], surfaces: ["tui"], reason: "CLI binary self-update flow" },
  { id: "tui.pair", names: ["pair", "web"], surfaces: ["tui"], reason: "Pair local CLI server with browser/mobile client" },
  { id: "tui.restart", names: ["restart"], surfaces: ["tui"], reason: "Restart local CLI/TUI server process" },
  { id: "tui.debug", names: ["debug"], surfaces: ["tui"], reason: "TUI internal debug diagnostics modal" },
  { id: "tui.help", names: ["help"], surfaces: ["tui"], reason: "TUI keybind & command reference modal" },
  { id: "tui.exit", names: ["exit", "quit", "q"], surfaces: ["tui"], reason: "Exit terminal CLI process" },
  { id: "tui.plugins", names: ["plugins"], surfaces: ["tui"], reason: "TUI plugin inspector (Web uses Settings > Extensions)" },
  { id: "tui.diff", names: ["diff"], surfaces: ["tui"], reason: "TUI diff modal (Web uses Review side panel)" },
  { id: "tui.stats", names: ["stats"], surfaces: ["tui"], reason: "TUI terminal usage stats modal" },
  { id: "tui.editor", names: ["editor"], surfaces: ["tui"], reason: "Open external terminal $EDITOR for prompt composition" },
  { id: "tui.skills", names: ["skills"], surfaces: ["tui"], reason: "TUI skill picker modal" },
  { id: "tui.worktrees", names: ["worktrees"], surfaces: ["tui"], reason: "TUI worktree switcher modal (Web uses workspace bar)" },
]

/**
 * Shared server-backed settings that must be exposed in both TUI DialogConfig
 * and Web/Desktop Settings > General.
 */
export const SHARED_SERVER_SETTINGS: readonly SettingParityEntry[] = [
  { path: "compaction.model", surfaces: ["tui", "web"] },
  { path: "objectives.max_actions_without_sync", surfaces: ["tui", "web"] },
  { path: "objectives.repeated_action_warning_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.search_attach_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.search_novel_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.finding_min_chars", surfaces: ["tui", "web"] },
  { path: "objectives.delegation_justification_min_chars", surfaces: ["tui", "web"] },
  { path: "objectives.fresh_session_percent_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.fresh_session_tokens_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.relevance_cooldown_ms", surfaces: ["tui", "web"] },
  { path: "objectives.primary_pre_compaction_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.subagent_pre_compaction_threshold", surfaces: ["tui", "web"] },
  { path: "objectives.min_subagent_budget", surfaces: ["tui", "web"] },
  { path: "objectives.embeddings_enabled", surfaces: ["tui", "web"] },
  { path: "objectives.unattended", surfaces: ["tui", "web"] },
  { path: "objectives.llamacpp_kv_offload", surfaces: ["tui", "web"] },
  { path: "objectives.llamacpp_slot_save_path", surfaces: ["tui", "web"] },
  { path: "objectives.subagent_model", surfaces: ["tui", "web"] },
  { path: "antigravity.connection_timeout_seconds", surfaces: ["tui", "web"] },
  { path: "antigravity.stream_idle_timeout_seconds", surfaces: ["tui", "web"] },
  { path: "antigravity.max_capacity_retries", surfaces: ["tui", "web"] },
  { path: "antigravity.max_capacity_delay_seconds", surfaces: ["tui", "web"] },
  { path: "antigravity.split_system_instruction", surfaces: ["tui", "web"] },
]
