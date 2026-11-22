import { createMemo, createSignal } from "solid-js"
import { useConfig, useNewDesigns } from "../config"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useThemes } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, DialogSelectChoice } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { DialogThemeList } from "./dialog-theme-list"
import { errorMessage } from "../util/error"

type Setting = {
  title: string
  category: string
  path: string[]
  /** Shown below the list while the setting is selected, under the "new-designs" experiment. */
  description: string
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
  /** Under the "new-designs" experiment, enter opens this picker instead of cycling. ←/→ still cycle. */
  open?: (dialog: DialogContext) => void
}

export const settings: Setting[] = [
  {
    title: "Theme",
    category: "Appearance",
    path: ["theme", "name"],
    description: "Color theme used across the interface",
    default: "opencode",
    keywords: ["color scheme", "colors"],
    open: (dialog) =>
      dialog.replace(() => (
        <DialogThemeList onClose={() => dialog.replace(() => <DialogConfig current="theme.name" />)} />
      )),
  },
  {
    title: "Color mode",
    category: "Appearance",
    path: ["theme", "mode"],
    description: "Dark or light variant, or follow the system",
    default: "system",
    values: ["system", "dark", "light"],
    keywords: ["dark mode", "light mode", "system theme"],
  },
  {
    title: "Animations",
    category: "Appearance",
    path: ["animations"],
    description: "Whether spinners and transitions animate",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["motion", "effects"],
  },
  {
    title: "Sidebar",
    category: "Session",
    path: ["session", "sidebar"],
    description: "Whether the sidebar shows when there is room",
    default: "auto",
    values: ["hide", "auto"],
    keywords: ["side panel"],
  },
  {
    title: "Scrollbar",
    category: "Session",
    path: ["session", "scrollbar"],
    description: "Whether a scrollbar is shown next to the chat",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll bar"],
  },
  {
    title: "Scroll on send",
    category: "Session",
    path: ["session", "submit_scroll"],
    description: "Whether sending a prompt jumps to the latest message",
    default: "bottom",
    values: ["bottom", "keep"],
    labels: ["jump to latest", "keep position"],
    keywords: ["submit", "scroll position", "jump to latest", "follow"],
  },
  {
    title: "Thinking",
    category: "Session",
    path: ["session", "thinking"],
    description: "Whether model thinking is shown in the chat",
    default: "hide",
    values: ["hide", "show"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Markdown",
    category: "Session",
    path: ["session", "markdown"],
    description: "Whether chat markdown is rendered or shown as source",
    default: "rendered",
    values: ["source", "rendered"],
    keywords: ["syntax", "concealment", "rendering"],
  },
  {
    title: "Tool grouping",
    category: "Session",
    path: ["session", "grouping"],
    description: "Whether consecutive reads and searches are grouped",
    default: "auto",
    values: ["none", "auto"],
    keywords: ["transcript", "messages", "reads", "searches"],
  },
  {
    title: "Verbosity",
    category: "Session",
    path: ["session", "verbosity"],
    description: "How much tool activity is shown in the chat",
    default: "low",
    values: ["low", "medium", "high"],
    keywords: ["detail", "activity", "summary", "transcript"],
  },
  {
    title: "Transcript images",
    category: "Session",
    path: ["session", "image_preview"],
    description: "Whether images are shown in the chat",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "images", "tool output"],
  },
  {
    title: "TPS",
    category: "Session",
    path: ["session", "tps"],
    description: "Whether tokens per second are shown for responses",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["tokens per second", "throughput"],
  },
  {
    title: "New session location",
    category: "Session",
    path: ["session", "new_location"],
    description: "Directory new sessions start in",
    default: "launch",
    values: ["launch", "inherit"],
    labels: ["launch directory", "active session"],
    keywords: ["directory", "cwd", "inherit"],
  },
  {
    title: "Permissions",
    category: "Session",
    path: ["session", "permissions"],
    description: "Whether permission requests ask you or auto accept",
    default: "prompt",
    values: ["prompt", "autoaccept"],
    labels: ["prompt", "auto accept"],
    keywords: ["approve", "accept", "permission requests"],
  },
  {
    title: "Compaction model",
    category: "Session",
    path: ["compaction", "model"],
    description: "Model used for conversation compaction; defaults to the active session model",
    default: "active",
    format: (value) => (!value || value === "active" ? "active model (default)" : String(value)),
    keywords: ["compact", "summary", "llm", "compaction model"],
    open: (dialog) =>
      dialog.replace(() => (
        <DialogCompactionModel onClose={() => dialog.replace(() => <DialogConfig current="compaction.model" />)} />
      )),
  },
  {
    title: "Mode",
    category: "Tabs",
    path: ["tabs", "mode"],
    description: "Whether sessions open in tabs",
    default: "auto",
    values: ["off", "on", "auto"],
  },
  {
    title: "Scope",
    category: "Tabs",
    path: ["tabs", "scope"],
    description: "Whether tabs are per directory or shared everywhere",
    default: "cwd",
    values: ["cwd", "global"],
    labels: ["current directory", "global"],
  },
  {
    title: "Layout",
    category: "Tabs",
    path: ["tabs", "layout"],
    description: "Whether tabs run along the top or down the side",
    default: "horizontal",
    values: ["horizontal", "vertical"],
    keywords: ["sidebar", "orientation", "left"],
  },
  {
    title: "Indicators",
    category: "Tabs",
    path: ["tabs", "indicators"],
    description: "Whether tabs show status icons or always numbers",
    default: "status",
    values: ["status", "numbers"],
    labels: ["status icons", "always show numbers"],
    keywords: ["tab numbers", "number mode", "status icons"],
  },
  {
    title: "Layout",
    category: "Diffs",
    path: ["diffs", "view"],
    description: "Whether diffs are side by side or in one column",
    default: "auto",
    values: ["auto", "split", "unified"],
    keywords: ["diff layout", "split diff", "unified diff"],
  },
  {
    title: "Wrapping",
    category: "Diffs",
    path: ["diffs", "wrap"],
    description: "Whether long lines in diffs wrap",
    default: "word",
    values: ["none", "word"],
    keywords: ["diff wrap", "word wrap", "line wrap"],
  },
  {
    title: "File tree",
    category: "Diffs",
    path: ["diffs", "tree"],
    description: "Whether a file tree is shown next to diffs",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["diff files"],
  },
  {
    title: "Single patch",
    category: "Diffs",
    path: ["diffs", "single"],
    description: "Whether diffs show one file at a time",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["one file", "selected file"],
  },
  {
    title: "Scroll speed",
    category: "Input",
    path: ["scroll", "speed"],
    description: "How far each scroll step moves",
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
    keywords: ["scrolling"],
  },
  {
    title: "Acceleration",
    category: "Input",
    path: ["scroll", "acceleration"],
    description: "Whether scrolling speeds up the faster you scroll",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll acceleration"],
  },
  {
    title: "Mouse",
    category: "Input",
    path: ["mouse"],
    description: "Whether the interface responds to the mouse",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["mouse capture"],
  },
  {
    title: "Editor context",
    category: "Input",
    path: ["prompt", "editor"],
    description: "Whether your editor's selection is added to prompts",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["file context", "prompt context", "editor selection"],
  },
  {
    title: "Large pastes",
    category: "Input",
    path: ["prompt", "paste"],
    description: "Whether large pastes are summarized or shown in full",
    default: "compact",
    values: ["compact", "full"],
    keywords: ["paste summary", "clipboard", "pasted content"],
  },
  {
    title: "Image previews",
    category: "Input",
    path: ["prompt", "image_preview"],
    description: "Whether attached images are previewed in the prompt",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "clipboard", "images", "prompt"],
  },
  {
    title: "Leader timeout",
    category: "Input",
    path: ["leader", "timeout"],
    description: "How long the leader key waits for the next key",
    default: 2000,
    step: 250,
    min: 250,
    max: 10000,
    format: (value) => `${value} ms`,
    keywords: ["leader key", "shortcut timeout"],
  },
  {
    title: "Notifications",
    category: "Alerts",
    path: ["attention", "notifications"],
    description: "Whether to notify when a session needs attention",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds",
    category: "Alerts",
    path: ["attention", "sound"],
    description: "Whether a sound plays when a session needs attention",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["audio", "sound effects", "alerts"],
  },
  {
    title: "Volume",
    category: "Alerts",
    path: ["attention", "volume"],
    description: "Volume of alert sounds",
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ["sound volume", "audio volume"],
  },
  {
    title: "Release highlights",
    category: "Alerts",
    path: ["highlights"],
    description: "Whether release highlights are shown after an update",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["what's new", "changelog", "release notes"],
  },
  {
    title: "Window title",
    category: "Terminal",
    path: ["terminal", "title"],
    description: "Whether the window title shows the current session",
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["terminal title", "tab title"],
  },
  {
    title: "Copy behavior",
    category: "Terminal",
    path: ["terminal", "copy"],
    description: "Whether selecting text copies it",
    default: process.platform === "win32" ? "manual" : "select",
    values: ["manual", "select"],
    keywords: ["selection", "clipboard"],
  },
  {
    title: "Developer tools",
    category: "Debug",
    path: ["debug", "devtools"],
    description: "Whether the developer tools bar is shown",
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["debug bar", "developer tools"],
  },
  {
    title: "Max actions without sync",
    category: "Objectives Protocol",
    path: ["objectives", "max_actions_without_sync"],
    description:
      "Consecutive tool operations (reads, searches, commands, edits) allowed without synchronizing the objective tree before emitting Objective Sync Warning (default: 15)",
    default: 15,
    step: 1,
    min: 1,
    max: 100,
    format: (value) => `${value} actions (def: 15)`,
    keywords: ["objectives", "objetivos", "sync", "warning", "reads", "anti-loop", "max_actions_without_sync"],
  },
  {
    title: "Repeated action threshold",
    category: "Objectives Protocol",
    path: ["objectives", "repeated_action_warning_threshold"],
    description:
      "Identical normalized read calls on the same active Secondary Objective before emitting a repeated-action warning (default: 2)",
    default: 2,
    step: 1,
    min: 1,
    max: 20,
    format: (value) => `${value} repetitions (def: 2)`,
    keywords: ["objectives", "objetivos", "repeated", "repeated_action_warning_threshold"],
  },
  {
    title: "Duplicate finding threshold",
    category: "Objectives Protocol",
    path: ["objectives", "search_attach_threshold"],
    description:
      "Similarity score (0.0–1.0) at or above which add_finding rejects duplicates and requires update_finding (default: 0.68)",
    default: 0.68,
    step: 0.02,
    min: 0.1,
    max: 1,
    format: (value) => `${Number(value).toFixed(2)} (def: 0.68)`,
    keywords: ["objectives", "objetivos", "finding", "similarity", "search_attach_threshold"],
  },
  {
    title: "Novel finding warning threshold",
    category: "Objectives Protocol",
    path: ["objectives", "search_novel_threshold"],
    description:
      "Similarity score (0.0–1.0) at or above which add_finding warns and links seeAlso automatically (default: 0.55)",
    default: 0.55,
    step: 0.02,
    min: 0.05,
    max: 0.98,
    format: (value) => `${Number(value).toFixed(2)} (def: 0.55)`,
    keywords: ["objectives", "objetivos", "finding", "novel", "search_novel_threshold"],
  },
  {
    title: "Min finding length",
    category: "Objectives Protocol",
    path: ["objectives", "finding_min_chars"],
    description:
      "Minimum character length required in finding title, result, and nextAction against placeholders (default: 15)",
    default: 15,
    step: 1,
    min: 3,
    max: 100,
    format: (value) => `${value} chars (def: 15)`,
    keywords: ["objectives", "objetivos", "finding", "placeholder", "finding_min_chars"],
  },
  {
    title: "Min delegation justification",
    category: "Objectives Protocol",
    path: ["objectives", "delegation_justification_min_chars"],
    description:
      "Minimum character length required in delegation.justification for main or subagent execution (default: 10)",
    default: 10,
    step: 1,
    min: 3,
    max: 100,
    format: (value) => `${value} chars (def: 10)`,
    keywords: ["objectives", "objetivos", "delegation", "delegation_justification_min_chars"],
  },
  {
    title: "Fresh Session % threshold",
    category: "Objectives Protocol",
    path: ["objectives", "fresh_session_percent_threshold"],
    description:
      "Context window percentage consumed during planning at or above which present_plan recommends Fresh Session (default: 35%)",
    default: 35,
    step: 5,
    min: 5,
    max: 95,
    format: (value) => `${value}% (def: 35%)`,
    keywords: ["objectives", "objetivos", "fresh session", "fresh_session_percent_threshold"],
  },
  {
    title: "Fresh Session token threshold",
    category: "Objectives Protocol",
    path: ["objectives", "fresh_session_tokens_threshold"],
    description:
      "Tokens consumed during planning at or above which present_plan recommends Fresh Session (default: 30000)",
    default: 30000,
    step: 5000,
    min: 5000,
    max: 200000,
    format: (value) => `${Number(value).toLocaleString()} tokens (def: 30,000)`,
    keywords: ["objectives", "objetivos", "fresh session", "tokens", "fresh_session_tokens_threshold"],
  },
  {
    title: "Docs relevance cooldown",
    category: "Objectives Protocol",
    path: ["objectives", "relevance_cooldown_ms"],
    description:
      "Minimum time in ms between one-shot documentation relevance evaluations on llama.cpp (default: 3000 ms)",
    default: 3000,
    step: 500,
    min: 0,
    max: 30000,
    format: (value) => `${value} ms (def: 3000 ms)`,
    keywords: ["objectives", "objetivos", "cooldown", "llamacpp", "relevance_cooldown_ms"],
  },
  {
    title: "Primary pre-compaction threshold",
    category: "Objectives Protocol",
    path: ["objectives", "primary_pre_compaction_threshold"],
    description:
      "Context ceiling percentage at which the primary session receives CRITICAL PRE-COMPACTION ADVISORY to consolidate objectives and call session_compact (default: 85%)",
    default: 85,
    step: 5,
    min: 50,
    max: 99,
    format: (value) => `${value}% (def: 85%)`,
    keywords: ["objectives", "objetivos", "compaction", "primary_pre_compaction_threshold"],
  },
  {
    title: "Subagent pre-compaction threshold",
    category: "Objectives Protocol",
    path: ["objectives", "subagent_pre_compaction_threshold"],
    description:
      "Context ceiling percentage at which subagents receive CRITICAL PRE-COMPACTION ADVISORY to stop exploration and return <OUTPUT> (default: 90%)",
    default: 90,
    step: 5,
    min: 50,
    max: 99,
    format: (value) => `${value}% (def: 90%)`,
    keywords: ["objectives", "objetivos", "subagent", "subagent_pre_compaction_threshold"],
  },
  {
    title: "Min subagent token budget",
    category: "Objectives Protocol",
    path: ["objectives", "min_subagent_budget"],
    description:
      "Minimum free token headroom required in context_budget to allow subagent delegation (default: 16000)",
    default: 16000,
    step: 2000,
    min: 2000,
    max: 100000,
    format: (value) => `${Number(value).toLocaleString()} tokens (def: 16,000)`,
    keywords: ["objectives", "objetivos", "budget", "subagent", "min_subagent_budget"],
  },
  {
    title: "Subagent model override",
    category: "Objectives Protocol",
    path: ["objectives", "subagent_model"],
    description: "Model used when spawning child subagents; defaults to the parent session's active model",
    default: "",
    format: (value) => (!value ? "parent session model (default)" : String(value)),
    keywords: ["objectives", "objetivos", "subagent", "model", "subagent_model"],
    open: (dialog) =>
      dialog.replace(() => (
        <DialogSubagentModel onClose={() => dialog.replace(() => <DialogConfig current="objectives.subagent_model" />)} />
      )),
  },
  {
    title: "Semantic embeddings (LM Studio)",
    category: "Objectives Protocol",
    path: ["objectives", "embeddings_enabled"],
    description: "Enable local LM Studio semantic embeddings for add_finding and search_findings (default: on)",
    default: true,
    values: [false, true],
    labels: ["off", "on (def)"],
    keywords: ["objectives", "objetivos", "embeddings", "lmstudio", "embeddings_enabled"],
  },
  {
    title: "Unattended mode (auto-approve)",
    category: "Objectives Protocol",
    path: ["objectives", "unattended"],
    description:
      "Automatically approve presented plans without freezing the session awaiting human confirmation (default: off)",
    default: false,
    values: [false, true],
    labels: ["off (def)", "on"],
    keywords: ["objectives", "objetivos", "unattended", "auto-approve"],
  },
  {
    title: "llama.cpp KV cache disk offload",
    category: "Objectives Protocol",
    path: ["objectives", "llamacpp_kv_offload"],
    description:
      "Save KV cache to disk and clear slot when dispatching subagents under parallel=2 to avoid VRAM OOM (default: on)",
    default: true,
    values: [false, true],
    labels: ["off", "on (def)"],
    keywords: ["objectives", "objetivos", "llamacpp", "kv", "offload", "subagent", "parallel"],
  },
  {
    title: "llama.cpp slot save path",
    category: "Objectives Protocol",
    path: ["objectives", "llamacpp_slot_save_path"],
    description: "Optional directory path where llama-server saves and restores slot KV cache snapshots",
    default: "",
    format: (value) => (!value ? "default" : String(value)),
    keywords: ["objectives", "objetivos", "llamacpp", "slot", "save", "path", "llamacpp_slot_save_path"],
    open: (dialog) =>
      dialog.replace(() => (
        <DialogSlotSavePath
          onClose={() => dialog.replace(() => <DialogConfig current="objectives.llamacpp_slot_save_path" />)}
        />
      )),
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const newDesigns = useNewDesigns()
  const dialog = useDialog()
  const toast = useToast()
  const themes = useThemes()
  let data: ReturnType<typeof useData> | undefined
  let location: ReturnType<typeof useLocation> | undefined
  let client: ReturnType<typeof useClient> | undefined
  try {
    data = useData()
  } catch {}
  try {
    location = useLocation()
  } catch {}
  try {
    client = useClient()
  } catch {}
  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)

  const serverCompactionModel = createMemo(() => {
    const entries = data && location ? (data.location.config.list(location.ref) ?? []) : []
    return entries
      .flatMap((entry) => {
        if (entry.type !== "document" || !entry.info.compaction?.model) return []
        const m = entry.info.compaction.model
        return typeof m === "string"
          ? [m]
          : [`${m.providerID}/${m.model}${m.variant ? `#${m.variant}` : ""}`]
      })
      .at(-1)
  })

  const serverObjectivesConfig = createMemo(() => {
    const entries = data && location ? (data.location.config.list(location.ref) ?? []) : []
    const merged: Record<string, unknown> = {}
    for (const entry of entries) {
      if (entry.type !== "document" || !entry.info.objectives) continue
      for (const [k, v] of Object.entries(entry.info.objectives)) {
        if (v !== undefined) merged[k] = v
      }
    }
    return merged
  })

  const availableModels = createMemo(() =>
    (data && location ? (data.location.model.list(location.ref) ?? []) : [])
      .map((item) => `${item.providerID}/${item.id}`)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
  )

  const value = (setting: Setting) => {
    const current = setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
    // The theme context resolves aliases and missing themes, so it names what is actually shown.
    if (setting.path.join(".") === "theme.name") return themes.selected
    if (setting.path.join(".") === "compaction.model") return serverCompactionModel() ?? current ?? setting.default
    if (setting.path[0] === "objectives" && setting.path[1]) {
      return serverObjectivesConfig()[setting.path[1]] ?? current ?? setting.default
    }
    return current ?? setting.default
  }
  const values = (setting: Setting) => {
    const id = setting.path.join(".")
    if (id === "theme.name")
      return Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    if (id === "compaction.model") return ["active", ...availableModels()]
    if (id === "objectives.subagent_model") return ["", ...availableModels()]
    return setting.values
  }
  const display = (setting: Setting) => {
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current))
  }
  const options = createMemo(() =>
    settings.map((setting, index) => ({
      title: setting.title,
      category: setting.category,
      searchText: setting.keywords?.join(" "),
      footer: newDesigns() ? (
        <DialogSelectChoice value={display(setting)} active={selected() === index} open={setting.open !== undefined} />
      ) : (
        display(setting)
      ),
      footerOverhang: newDesigns() ? 2 : undefined,
      detail: newDesigns() ? setting.description : undefined,
      value: index,
    })),
  )

  async function change(direction: number, index = selected()) {
    if (saving()) return
    const setting = settings[index]
    const current = value(setting)
    const choices = values(setting)
    if (setting.open && !choices && setting.step === undefined) {
      setting.open(dialog)
      return
    }
    const rawNext = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    const next = typeof rawNext === "number" && !Number.isInteger(setting.step ?? 1) ? Number(rawNext.toFixed(2)) : rawNext
    if (next === current) return
    setSaving(true)
    const isCompactionModel = setting.path.join(".") === "compaction.model"
    const isObjectivesSetting = setting.path[0] === "objectives" && Boolean(setting.path[1])

    await Promise.all([
      config.update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      }),
      ...(isCompactionModel && client
        ? [
            client.api.experimental.config.update({
              compaction: { model: next === "active" ? null : String(next) },
            }),
          ]
        : []),
      ...(isObjectivesSetting && client
        ? [
            client.api.experimental.config.update({
              objectives: { [setting.path[1]!]: next === "" ? null : next },
            }),
          ]
        : []),
    ])
      .catch((err) => toast.show({ message: errorMessage(err), variant: "error", duration: 5000 }))
      .finally(() => setSaving(false))
  }

  return (
    <DialogSelect
      title="Settings"
      searchInTitle
      titlePlaceholder="Search settings"
      options={options()}
      // Under new designs the opening setting is focused without the current-item marker; changing a value keeps the
      // selection where it is.
      current={newDesigns() ? undefined : current}
      focusTarget={newDesigns() ? current : undefined}
      preserveSelection={newDesigns()}
      filterThreshold={0.7}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => {
        const setting = settings[option.value]
        const open = setting.open
        const id = settingID(setting)
        if (
          (newDesigns() ||
            id === "compaction.model" ||
            id === "objectives.subagent_model" ||
            id === "objectives.llamacpp_slot_save_path") &&
          open
        )
          return open(dialog)
        void change(1, option.value)
      }}
      footerHints={newDesigns() ? [] : [{ title: "change", label: "←/→" }]}
      bindings={[
        {
          bind: "left",
          title: "Previous value",
          group: "Settings",
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: "Next value",
          group: "Settings",
          run: () => void change(1),
        },
      ]}
    />
  )
}

function DialogCompactionModel(props: { onClose?: () => void }) {
  const config = useConfig()
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()

  const currentModel = createMemo(() => {
    const entries = data.location.config.list(location.ref) ?? []
    const fromServer = entries
      .flatMap((entry) => {
        if (entry.type !== "document" || !entry.info.compaction?.model) return []
        const m = entry.info.compaction.model
        return typeof m === "string"
          ? [m]
          : [`${m.providerID}/${m.model}${m.variant ? `#${m.variant}` : ""}`]
      })
      .at(-1)
    return fromServer ?? config.data.compaction?.model ?? "active"
  })

  const options = createMemo(() => {
    const providers = new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item]))
    const models = (data.location.model.list(location.ref) ?? [])
      .map((model) => {
        const key = `${model.providerID}/${model.id}`
        return {
          title: model.name || model.id,
          category: providers.get(model.providerID)?.name ?? model.providerID,
          footer: key,
          searchText: `${model.providerID} ${model.id} ${model.name}`,
          value: key,
        }
      })
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base" }))
    return [
      {
        title: "Active model (default)",
        category: "Default",
        footer: "Uses the session's active model",
        searchText: "active default current model",
        value: "active",
      },
      ...models,
    ]
  })

  return (
    <DialogSelect
      title="Compaction model"
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      current={currentModel()}
      onCancel={props.onClose}
      onSelect={(opt) => {
        const next = opt.value
        void Promise.all([
          config.update((draft) => {
            if (!draft.compaction || typeof draft.compaction !== "object") draft.compaction = {}
            draft.compaction.model = next
          }),
          client.api.experimental.config.update({
            compaction: { model: next === "active" ? null : next },
          }),
        ])
          .catch(toast.error)
          .finally(() => {
            if (props.onClose) return props.onClose()
            dialog.clear()
          })
      }}
    />
  )
}

function DialogSubagentModel(props: { onClose?: () => void }) {
  const config = useConfig()
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()

  const currentModel = createMemo(() => {
    const entries = data.location.config.list(location.ref) ?? []
    const fromServer = entries
      .flatMap((entry) => {
        if (entry.type !== "document" || !entry.info.objectives?.subagent_model) return []
        return [entry.info.objectives.subagent_model]
      })
      .at(-1)
    return fromServer ?? (config.data.objectives as { subagent_model?: string } | undefined)?.subagent_model ?? ""
  })

  const options = createMemo(() => {
    const providers = new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item]))
    const models = (data.location.model.list(location.ref) ?? [])
      .map((model) => {
        const key = `${model.providerID}/${model.id}`
        return {
          title: model.name || model.id,
          category: providers.get(model.providerID)?.name ?? model.providerID,
          footer: key,
          searchText: `${model.providerID} ${model.id} ${model.name}`,
          value: key,
        }
      })
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base" }))
    return [
      {
        title: "Parent session model (default)",
        category: "Default",
        footer: "Uses the parent session's active model",
        searchText: "default parent session model",
        value: "",
      },
      ...models,
    ]
  })

  return (
    <DialogSelect
      title="Subagent model override"
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      current={currentModel()}
      onCancel={props.onClose}
      onSelect={(opt) => {
        const next = opt.value
        void Promise.all([
          config.update((draft) => {
            if (!draft.objectives || typeof draft.objectives !== "object") draft.objectives = {}
            ;(draft.objectives as Record<string, unknown>).subagent_model = next
          }),
          client.api.experimental.config.update({
            objectives: { subagent_model: next || null },
          }),
        ])
          .catch(toast.error)
          .finally(() => {
            if (props.onClose) return props.onClose()
            dialog.clear()
          })
      }}
    />
  )
}

function DialogSlotSavePath(props: { onClose?: () => void }) {
  const config = useConfig()
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()

  const currentPath = createMemo(() => {
    const entries = data.location.config.list(location.ref) ?? []
    const fromServer = entries
      .flatMap((entry) => {
        if (entry.type !== "document" || entry.info.objectives?.llamacpp_slot_save_path === undefined) return []
        return [entry.info.objectives.llamacpp_slot_save_path]
      })
      .at(-1)
    return (
      fromServer ??
      (config.data.objectives as { llamacpp_slot_save_path?: string } | undefined)?.llamacpp_slot_save_path ??
      ""
    )
  })

  const finish = () => {
    if (props.onClose) return props.onClose()
    dialog.clear()
  }

  return (
    <DialogPrompt
      title="llama.cpp slot save path"
      placeholder="/path/to/kv-slots (leave empty for default)"
      value={currentPath()}
      onCancel={finish}
      onConfirm={(input) => {
        const next = input.trim()
        void Promise.all([
          config.update((draft) => {
            if (!draft.objectives || typeof draft.objectives !== "object") draft.objectives = {}
            ;(draft.objectives as Record<string, unknown>).llamacpp_slot_save_path = next
          }),
          client.api.experimental.config.update({
            objectives: { llamacpp_slot_save_path: next || null },
          }),
        ])
          .catch(toast.error)
          .finally(finish)
      }}
    />
  )
}
