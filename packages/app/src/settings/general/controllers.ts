import { createEffect, createMemo, createSignal, onMount, untrack, type Accessor } from "solid-js"
import type { ConfigShellOption } from "@opencode/client/promise"
import type { ColorScheme } from "@opencode/ui/theme/context"
import { useTheme } from "@opencode/ui/theme/context"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  type ReduceMotion,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/settings/model"
import { usePlatform } from "@/runtime/platform/platform"
import { desktopZoomLevels, type DesktopZoomLevel } from "@/shell/commands/desktop-menu"
import { playSoundById, SOUND_OPTIONS } from "@/shell/notifications/sound"
import { createSoundPreviewController } from "./behavior"
import { ServerConnection } from "@/runtime/server/registry"
import { useServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import { errorMessage } from "@/shell/layout/helpers"
import {
  createOptimisticSettingState,
  selectSettingMeta,
  selectSettingValue,
  transitionOptimisticSetting,
  type OptimisticSettingEffect,
  type OptimisticSettingEvent,
  type SettingWriteFailure,
} from "./machine"

/**
 * Drives one optimistically written setting. Writes outlive the owner on purpose: a queued choice still reaches the
 * source after Settings closes, and a failure still reports.
 */
export function createOptimisticSetting<T, M, S>(options: {
  /** `undefined` while no source can take the setting; another value reads it again. */
  source: Accessor<S | undefined>
  initial: T
  initialMeta: M
  load: (source: S) => Promise<{ value: T; meta: M }>
  write: (value: T, source: S) => Promise<void> | void
  onError?: (failure: SettingWriteFailure) => void
}) {
  const [state, setState] = createSignal(createOptimisticSettingState<T, M, S>(options.initial, options.initialMeta))
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  const dispatch = (event: OptimisticSettingEvent<T, M, S>) =>
    untrack(() => {
      const previous = state()
      const next = transitionOptimisticSetting(previous, event)

      if (next.state !== previous) setState(next.state)
      next.effects.forEach(run)
    })

  const settle = (attempt: number, event: OptimisticSettingEvent<T, M, S>) => {
    clearTimeout(timers.get(attempt))
    timers.delete(attempt)
    dispatch(event)
  }

  function run(effect: OptimisticSettingEffect<T, S>) {
    if (effect.type === "notify.error") return options.onError?.(effect.failure)

    const attempt = effect.attempt

    if (effect.type === "load") {
      void Promise.try(() => options.load(effect.source)).then(
        (result) => dispatch({ type: "load.succeeded", attempt, value: result.value, meta: result.meta }),
        () => dispatch({ type: "load.failed", attempt }),
      )

      return
    }

    timers.set(
      attempt,
      setTimeout(() => settle(attempt, { type: "write.timed-out", attempt }), effect.timeoutMs),
    )
    void Promise.try(() => options.write(effect.value, effect.source)).then(
      () => settle(attempt, { type: "write.succeeded", attempt }),
      (cause) => settle(attempt, { type: "write.failed", attempt, message: errorMessage(cause, "") }),
    )
  }

  createEffect(() => dispatch({ type: "source.synced", source: options.source() }))

  return {
    value: () => selectSettingValue(state()),
    meta: () => selectSettingMeta(state()),
    select: (value: T) => dispatch({ type: "write.requested", value }),
  }
}

export function createServerShellController(server: Accessor<ServerConnection.Any>) {
  const language = useLanguage()

  // Reads again for the controller a server's new credentials start; a server without one keeps the last value.
  const setting = createOptimisticSetting({
    source: useServerCtx(server),
    initial: "",
    initialMeta: Array.of<ConfigShellOption>(),
    load: async (context) => {
      const [entries, shells] = await Promise.all([
        context.sdk.api.config.get().catch(() => []),
        context.sdk.api.config.shells().catch(() => []),
      ])

      const boundary = entries.findIndex((entry) => entry.type === "directory")
      const global = boundary === -1 ? entries : entries.slice(0, boundary)

      return {
        meta: shells,
        value:
          global
            .flatMap((entry) => (entry.type === "document" && entry.info.shell !== undefined ? [entry.info.shell] : []))
            .at(-1) ?? "",
      }
    },
    write: async (value, context) => {
      await context.sdk.api.experimental.config.update({ shell: value || null })
    },
    onError: (failure) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description:
          failure.kind === "timeout"
            ? language.t("home.sessions.load.timeout")
            : failure.message || language.t("common.requestFailed"),
      }),
  })

  return {
    shells: setting.meta,
    current: setting.value,
    select: setting.select,
  }
}

export type CompactionModelOption = { id: string; name: string }

export function createServerCompactionModelController(server: Accessor<ServerConnection.Any>) {
  const language = useLanguage()

  const setting = createOptimisticSetting({
    source: useServerCtx(server),
    initial: "",
    initialMeta: Array.of<CompactionModelOption>(),
    load: async (context) => {
      const [entries, models] = await Promise.all([
        context.sdk.api.config.get().catch(() => []),
        context.sdk.api.model
          .list()
          .then((res) => res.data)
          .catch(() => []),
      ])

      const boundary = entries.findIndex((entry) => entry.type === "directory")
      const global = boundary === -1 ? entries : entries.slice(0, boundary)

      const options = models
        .map((m) => ({
          id: `${m.providerID}/${m.id}`,
          name: `${m.providerID}/${m.name || m.id}`,
        }))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }))

      const current =
        global
          .flatMap((entry) => {
            if (entry.type !== "document" || !entry.info.compaction?.model) return []
            const m = entry.info.compaction.model
            return typeof m === "string"
              ? [m]
              : [`${m.providerID}/${m.model}${m.variant ? `#${m.variant}` : ""}`]
          })
          .at(-1) ?? ""

      return {
        meta: options,
        value: current,
      }
    },
    write: async (value, context) => {
      await context.sdk.api.experimental.config.update({ compaction: { model: value || null } })
    },
    onError: (failure) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description:
          failure.kind === "timeout"
            ? language.t("home.sessions.load.timeout")
            : failure.message || language.t("common.requestFailed"),
      }),
  })

  return {
    models: setting.meta,
    current: setting.value,
    select: setting.select,
  }
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const platform = usePlatform()
  const language = useLanguage()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    zoom: {
      available: () => platform.zoomLevel !== undefined,
      options: [...desktopZoomLevels],
      current: () => platform.zoomLevel?.() ?? 1,
      label: (level: DesktopZoomLevel) => new Intl.NumberFormat(language.intl(), { style: "percent" }).format(level),
      select: (level: DesktopZoomLevel) => void platform.setZoomLevel?.(level),
    },
    reduceMotion: {
      current: settings.appearance.reduceMotion,
      select: (value: ReduceMotion) => settings.appearance.setReduceMotion(value),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont()),
        placeholder: sansDefault,
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font()),
        placeholder: monoDefault,
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont()),
        placeholder: terminalDefault,
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const

export const soundOptions = [noneSound, ...SOUND_OPTIONS]

export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)

  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return

      if (option.id === "none") {
        setEnabled(false)
        preview.stop()

        return
      }

      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    questions: channel(
      settings.sounds.questionsEnabled,
      settings.sounds.questions,
      (value) => settings.sounds.setQuestionsEnabled(value),
      (id) => settings.sounds.setQuestions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type ObjectivesConfigValues = {
  max_actions_without_sync: number
  repeated_action_warning_threshold: number
  search_attach_threshold: number
  search_novel_threshold: number
  finding_min_chars: number
  delegation_justification_min_chars: number
  fresh_session_percent_threshold: number
  fresh_session_tokens_threshold: number
  relevance_cooldown_ms: number
  primary_pre_compaction_threshold: number
  subagent_pre_compaction_threshold: number
  min_subagent_budget: number
  embeddings_enabled: boolean
  unattended: boolean
  llamacpp_kv_offload: boolean
  llamacpp_slot_save_path?: string
  subagent_model?: string
}

export const DEFAULT_OBJECTIVES_UI_CONFIG: ObjectivesConfigValues = {
  max_actions_without_sync: 15,
  repeated_action_warning_threshold: 2,
  search_attach_threshold: 0.68,
  search_novel_threshold: 0.55,
  finding_min_chars: 15,
  delegation_justification_min_chars: 10,
  fresh_session_percent_threshold: 35,
  fresh_session_tokens_threshold: 30000,
  relevance_cooldown_ms: 3000,
  primary_pre_compaction_threshold: 85,
  subagent_pre_compaction_threshold: 90,
  min_subagent_budget: 16000,
  embeddings_enabled: true,
  unattended: false,
  llamacpp_kv_offload: true,
}

export function createServerObjectivesController(server: Accessor<ServerConnection.Any | undefined>) {
  const language = useLanguage()

  const setting = createOptimisticSetting({
    source: useServerCtx(server),
    initial: DEFAULT_OBJECTIVES_UI_CONFIG,
    initialMeta: undefined,
    load: async (context) => {
      const entries = await context.sdk.api.config.get().catch(() => [])
      const merged: ObjectivesConfigValues = { ...DEFAULT_OBJECTIVES_UI_CONFIG }
      for (const entry of entries) {
        if (entry.type !== "document" || !entry.info.objectives) continue
        const obj = entry.info.objectives
        for (const [k, v] of Object.entries(obj)) {
          if (v !== undefined && k in merged) {
            ;(merged as Record<string, unknown>)[k] = v
          }
        }
      }
      return {
        meta: undefined,
        value: merged,
      }
    },
    write: async (value, context) => {
      await context.sdk.api.experimental.config.update({ objectives: value })
    },
    onError: (failure) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description:
          failure.kind === "timeout"
            ? language.t("home.sessions.load.timeout")
            : failure.message || language.t("common.requestFailed"),
      }),
  })

  return {
    current: setting.value,
    update: <K extends keyof ObjectivesConfigValues>(key: K, value: ObjectivesConfigValues[K]) => {
      setting.select({ ...setting.value(), [key]: value })
    },
    resetDefaults: () => {
      setting.select({ ...DEFAULT_OBJECTIVES_UI_CONFIG })
    },
  }
}

export type ShellSettingsController = ReturnType<typeof createServerShellController>

export type CompactionModelSettingsController = ReturnType<typeof createServerCompactionModelController>

export type ObjectivesSettingsController = ReturnType<typeof createServerObjectivesController>

export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>

export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
