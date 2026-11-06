import { Component, Show, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TimelineDetailControl } from "@/settings/timeline-detail"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { PluginSettingsSections } from "@/runtime/plugin/settings-page-view"
import {
  type BackgroundActivity,
  type FollowUpBehavior,
  type TimelineWidth,
  type WorkspaceDefaultDestination,
  useSettings,
} from "@/settings/model"
import { formatKeybind } from "@/shell/commands/command"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createShellOptions } from "./behavior"
import {
  createOptimisticSetting,
  createServerObjectivesController,
  DEFAULT_OBJECTIVES_UI_CONFIG,
  type CompactionModelSettingsController,
  type ObjectivesSettingsController,
  type ShellSettingsController,
} from "./controllers"
import { useSettingsSurface } from "@/settings/surface"
import { InterfaceModeSetting } from "./interface-mode"
import "@/settings/settings.css"

const AutoApprovePermissionsSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <SettingsRow
      title={language.t("command.permissions.autoaccept.enable")}
      description={language.t("settings.permissions.autoAccept.default.description")}
    >
      <div data-action="settings-auto-accept-permissions">
        <Switch
          checked={settings.permissions.autoApproveDefault()}
          onChange={(checked) => settings.permissions.setAutoApproveDefault(checked)}
        />
      </div>
    </SettingsRow>
  )
}

const WorkspaceDestinationSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: WorkspaceDefaultDestination; label: string }[] => [
    { value: "last-used", label: language.t("settings.workspaces.default.lastUsed") },
    { value: "local", label: language.t("settings.workspaces.default.local") },
    { value: "new", label: language.t("settings.workspaces.default.new") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.workspaces.default.title")}
      description={language.t("settings.workspaces.default.description")}
    >
      <Select
        data-action="settings-workspace-destination"
        options={options()}
        current={options().find((option) => option.value === settings.workspaces.defaultDestination())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.workspaces.setDefaultDestination(option.value)}
      />
    </SettingsRow>
  )
}

export const ShellSetting: Component<{
  controller: ShellSettingsController
  /** Search reveals the row with the default action; the Servers page names the other servers' rows apart. */
  action?: string
}> = (props) => {
  const language = useLanguage()

  const options = createMemo(() =>
    createShellOptions({
      shells: props.controller.shells(),
      current: props.controller.current(),
    }),
  )

  return (
    <SettingsRow
      title={language.t("settings.general.row.shell.title")}
      description={language.t("settings.general.row.shell.description")}
    >
      <Select
        data-action={props.action ?? "settings-shell"}
        options={options()}
        current={options().find((option) => option.value === props.controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => {
          if (option.id === "auto") return language.t("settings.general.row.shell.autoDefault")

          if (!option.terminalOnly) return option.name

          return `${option.name} (${language.t("settings.general.row.shell.terminalOnly")})`
        }}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRow>
  )
}

export const CompactionModelSetting: Component<{
  controller: CompactionModelSettingsController
  action?: string
}> = (props) => {
  const options = createMemo(() => {
    const current = props.controller.current()

    const base = [
      { id: "active", value: "", name: "Active model (default)" },
      ...props.controller.models().map((m) => ({ id: m.id, value: m.id, name: m.name })),
    ]

    if (current && !base.some((opt) => opt.value === current)) {
      return [...base, { id: current, value: current, name: current }]
    }

    return base
  })

  return (
    <SettingsRow
      title="Compaction model"
      description="LLM used for conversation compaction; returns to the session's active model once compaction completes."
    >
      <Select
        data-action={props.action ?? "settings-compaction-model"}
        options={options()}
        current={options().find((option) => option.value === props.controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => option.name}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRow>
  )
}

export const ObjectivesProtocolSection: Component<{
  controller: ObjectivesSettingsController
}> = (props) => {
  const numSelectOptions = (values: number[], defaultVal: number, suffix = "") =>
    values.map((v) => ({
      value: v,
      label: `${v}${suffix}${v === defaultVal ? " (por defecto)" : ""}`,
    }))

  const maxActionsOptions = numSelectOptions([5, 10, 15, 20, 25, 30, 50], DEFAULT_OBJECTIVES_UI_CONFIG.max_actions_without_sync, " acciones")
  const repeatedOptions = numSelectOptions([1, 2, 3, 4, 5], DEFAULT_OBJECTIVES_UI_CONFIG.repeated_action_warning_threshold, " repeticiones")
  const attachThresholdOptions = [0.55, 0.6, 0.65, 0.68, 0.72, 0.75, 0.8, 0.85].map((v) => ({
    value: v,
    label: `${v.toFixed(2)}${v === DEFAULT_OBJECTIVES_UI_CONFIG.search_attach_threshold ? " (por defecto)" : ""}`,
  }))
  const novelThresholdOptions = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((v) => ({
    value: v,
    label: `${v.toFixed(2)}${v === DEFAULT_OBJECTIVES_UI_CONFIG.search_novel_threshold ? " (por defecto)" : ""}`,
  }))
  const findingCharsOptions = numSelectOptions([5, 10, 15, 20, 30], DEFAULT_OBJECTIVES_UI_CONFIG.finding_min_chars, " caracteres")
  const delegationCharsOptions = numSelectOptions([5, 10, 15, 20, 30], DEFAULT_OBJECTIVES_UI_CONFIG.delegation_justification_min_chars, " caracteres")
  const freshPercentOptions = numSelectOptions([20, 25, 30, 35, 40, 50, 60], DEFAULT_OBJECTIVES_UI_CONFIG.fresh_session_percent_threshold, "%")
  const freshTokensOptions = [15000, 20000, 30000, 45000, 60000, 100000].map((v) => ({
    value: v,
    label: `${v.toLocaleString()} tokens${v === DEFAULT_OBJECTIVES_UI_CONFIG.fresh_session_tokens_threshold ? " (por defecto)" : ""}`,
  }))
  const cooldownOptions = [0, 1000, 2000, 3000, 5000, 10000].map((v) => ({
    value: v,
    label: `${v} ms${v === DEFAULT_OBJECTIVES_UI_CONFIG.relevance_cooldown_ms ? " (por defecto)" : ""}`,
  }))
  const primaryCompactionOptions = numSelectOptions([70, 75, 80, 85, 90, 95], DEFAULT_OBJECTIVES_UI_CONFIG.primary_pre_compaction_threshold, "%")
  const subagentCompactionOptions = numSelectOptions([75, 80, 85, 90, 95], DEFAULT_OBJECTIVES_UI_CONFIG.subagent_pre_compaction_threshold, "%")
  const minSubagentBudgetOptions = [8000, 12000, 16000, 24000, 32000, 48000].map((v) => ({
    value: v,
    label: `${v.toLocaleString()} tokens${v === DEFAULT_OBJECTIVES_UI_CONFIG.min_subagent_budget ? " (por defecto)" : ""}`,
  }))

  return (
    <section class="settings-section" aria-label="Protocolo de Objetivos">
      <h3 class="settings-section-title">Protocolo de Objetivos</h3>
      <SettingsList>
        <SettingsRow
          title="Acciones máximas sin sincronizar objetivos (max_actions_without_sync)"
          description="Número máximo de operaciones consecutivas (lecturas, búsquedas, comandos o ediciones) permitidas sin actualizar el árbol de objetivos en objective_manage antes de emitir ⚠️ [Objective Sync Warning]. Valor por defecto: 15."
        >
          <Select
            data-action="settings-objectives-max-actions-without-sync"
            options={maxActionsOptions}
            current={
              maxActionsOptions.find((o) => o.value === props.controller.current().max_actions_without_sync) ??
              maxActionsOptions[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("max_actions_without_sync", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de advertencia por acción repetida (repeated_action_warning_threshold)"
          description="Cantidad de lecturas normalizadas idénticas sobre el mismo Objetivo Secundario activo antes de emitir advertencia anti-bucle. Valor por defecto: 2."
        >
          <Select
            data-action="settings-objectives-repeated-action-threshold"
            options={repeatedOptions}
            current={
              repeatedOptions.find((o) => o.value === props.controller.current().repeated_action_warning_threshold) ??
              repeatedOptions[1]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("repeated_action_warning_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de similitud para bloqueo de duplicados (search_attach_threshold)"
          description="Puntaje de similitud (0.0–1.0) a partir del cual add_finding rechaza un hallazgo por ser duplicado y exige extender el existente con update_finding. Valor por defecto: 0.68."
        >
          <Select
            data-action="settings-objectives-search-attach-threshold"
            options={attachThresholdOptions}
            current={
              attachThresholdOptions.find((o) => o.value === props.controller.current().search_attach_threshold) ??
              attachThresholdOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("search_attach_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de similitud para advertencia y enlace seeAlso (search_novel_threshold)"
          description="Puntaje de similitud (0.0–1.0) a partir del cual add_finding emite advertencia de similitud y enlaza automáticamente seeAlso. Valor por defecto: 0.55."
        >
          <Select
            data-action="settings-objectives-search-novel-threshold"
            options={novelThresholdOptions}
            current={
              novelThresholdOptions.find((o) => o.value === props.controller.current().search_novel_threshold) ??
              novelThresholdOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("search_novel_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Longitud mínima de campos de hallazgo (finding_min_chars)"
          description="Mínimo de caracteres exigidos en title, result y nextAction al registrar hallazgos (validación anti-placeholder). Valor por defecto: 15."
        >
          <Select
            data-action="settings-objectives-finding-min-chars"
            options={findingCharsOptions}
            current={
              findingCharsOptions.find((o) => o.value === props.controller.current().finding_min_chars) ??
              findingCharsOptions[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("finding_min_chars", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Longitud mínima de justificación de delegación (delegation_justification_min_chars)"
          description="Mínimo de caracteres exigidos en delegation.justification (main vs subagent) para objetivos y hallazgos. Valor por defecto: 10."
        >
          <Select
            data-action="settings-objectives-delegation-min-chars"
            options={delegationCharsOptions}
            current={
              delegationCharsOptions.find(
                (o) => o.value === props.controller.current().delegation_justification_min_chars,
              ) ?? delegationCharsOptions[1]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("delegation_justification_min_chars", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de porcentaje para recomendar Fresh Session (fresh_session_percent_threshold)"
          description="Porcentaje de ventana de contexto consumido durante la exploración/planificación a partir del cual present_plan recomienda iniciar ejecución en una Fresh Session. Valor por defecto: 35%."
        >
          <Select
            data-action="settings-objectives-fresh-session-percent"
            options={freshPercentOptions}
            current={
              freshPercentOptions.find((o) => o.value === props.controller.current().fresh_session_percent_threshold) ??
              freshPercentOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("fresh_session_percent_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de tokens para recomendar Fresh Session (fresh_session_tokens_threshold)"
          description="Tokens consumidos durante la exploración/planificación a partir de los cuales present_plan recomienda iniciar ejecución en una Fresh Session. Valor por defecto: 30,000 tokens."
        >
          <Select
            data-action="settings-objectives-fresh-session-tokens"
            options={freshTokensOptions}
            current={
              freshTokensOptions.find((o) => o.value === props.controller.current().fresh_session_tokens_threshold) ??
              freshTokensOptions[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("fresh_session_tokens_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Cooldown de evaluación de relevancia documental (relevance_cooldown_ms)"
          description="Tiempo mínimo en milisegundos entre evaluaciones one-shot aisladas de relevancia documental sobre llama.cpp (id_slot: 1). Valor por defecto: 3000 ms."
        >
          <Select
            data-action="settings-objectives-relevance-cooldown-ms"
            options={cooldownOptions}
            current={
              cooldownOptions.find((o) => o.value === props.controller.current().relevance_cooldown_ms) ??
              cooldownOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("relevance_cooldown_ms", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de aviso pre-compactación en hilo principal (primary_pre_compaction_threshold)"
          description="Porcentaje del techo de contexto en el que la sesión principal recibe el aviso CRITICAL PRE-COMPACTION ADVISORY para consolidar objetivos e invocar session_compact. Valor por defecto: 85%."
        >
          <Select
            data-action="settings-objectives-primary-compaction-threshold"
            options={primaryCompactionOptions}
            current={
              primaryCompactionOptions.find(
                (o) => o.value === props.controller.current().primary_pre_compaction_threshold,
              ) ?? primaryCompactionOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("primary_pre_compaction_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Umbral de aviso pre-compactación en subagentes (subagent_pre_compaction_threshold)"
          description="Porcentaje del techo de contexto en el que un subagente recibe el aviso CRITICAL PRE-COMPACTION ADVISORY para detener exploración y devolver <OUTPUT>. Valor por defecto: 90%."
        >
          <Select
            data-action="settings-objectives-subagent-compaction-threshold"
            options={subagentCompactionOptions}
            current={
              subagentCompactionOptions.find(
                (o) => o.value === props.controller.current().subagent_pre_compaction_threshold,
              ) ?? subagentCompactionOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("subagent_pre_compaction_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Presupuesto mínimo de tokens para subagentes (min_subagent_budget)"
          description="Margen mínimo de tokens libres requerido en context_budget para autorizar delegación a subagentes (canDelegate: true). Valor por defecto: 16,000 tokens."
        >
          <Select
            data-action="settings-objectives-min-subagent-budget"
            options={minSubagentBudgetOptions}
            current={
              minSubagentBudgetOptions.find((o) => o.value === props.controller.current().min_subagent_budget) ??
              minSubagentBudgetOptions[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("min_subagent_budget", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Embeddings semánticos para hallazgos (embeddings_enabled)"
          description="Habilita el cálculo de similitud semántica mediante LM Studio local para add_finding y search_findings. Valor por defecto: activado (true)."
        >
          <div data-action="settings-objectives-embeddings-enabled">
            <Switch
              checked={props.controller.current().embeddings_enabled}
              onChange={(checked) => props.controller.update("embeddings_enabled", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Modo desatendido / autónomo (unattended)"
          description="Aprueba automáticamente los planes presentados sin congelar el árbol en presented_awaiting_confirmation esperando confirmación humana. Valor por defecto: desactivado (false)."
        >
          <div data-action="settings-objectives-unattended">
            <Switch
              checked={props.controller.current().unattended}
              onChange={(checked) => props.controller.update("unattended", checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </section>
  )
}

const FollowUpBehaviorSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: FollowUpBehavior; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followUpBehavior.queue") },
    { value: "steer", label: language.t("settings.general.row.followUpBehavior.steer") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.general.row.followUpBehavior.title")}
      description={language.t("settings.general.row.followUpBehavior.description", {
        keybind: formatKeybind("mod+enter", language.t),
      })}
    >
      <Select
        data-action="settings-follow-up-behavior"
        options={options()}
        current={options().find((option) => option.value === settings.general.followUpBehavior())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setFollowUpBehavior(option.value)}
      />
    </SettingsRow>
  )
}

const BackgroundActivitySetting = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: BackgroundActivity; label: string }[] => [
    { value: "off", label: language.t("settings.timeline.row.backgroundActivity.off") },
    { value: "left", label: language.t("settings.timeline.row.backgroundActivity.left") },
    { value: "center", label: language.t("settings.timeline.row.backgroundActivity.center") },
    { value: "right", label: language.t("settings.timeline.row.backgroundActivity.right") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.timeline.row.backgroundActivity.title")}
      description={language.t("settings.timeline.row.backgroundActivity.description")}
    >
      <Select
        data-action="settings-background-activity"
        aria-label={language.t("settings.timeline.row.backgroundActivity.title")}
        options={options()}
        current={options().find((option) => option.value === settings.general.backgroundActivity())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setBackgroundActivity(option.value)}
      />
    </SettingsRow>
  )
}

const TimelineWidthSetting = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: TimelineWidth; label: string }[] => [
    { value: "focused", label: language.t("settings.timeline.row.width.focused") },
    { value: "comfortable", label: language.t("settings.timeline.row.width.comfortable") },
    { value: "wide", label: language.t("settings.timeline.row.width.wide") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.timeline.row.width.title")}
      description={language.t("settings.timeline.row.width.description")}
    >
      <Select
        data-action="settings-timeline-width"
        aria-label={language.t("settings.timeline.row.width.title")}
        options={options()}
        current={options().find((option) => option.value === settings.general.timelineWidth())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setTimelineWidth(option.value)}
      />
    </SettingsRow>
  )
}

const LanguageSetting = () => {
  const language = useLanguage()

  const options = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  return (
    <SettingsRow
      title={language.t("settings.general.row.language.title")}
      description={language.t("settings.general.row.language.description")}
    >
      <Select
        data-action="settings-language"
        options={options()}
        placement="bottom-end"
        gutter={6}
        current={options().find((option) => option.value === language.locale())}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && language.setLocale(option.value)}
      />
    </SettingsRow>
  )
}

export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const surface = useSettingsSurface()
  const objectivesController = createServerObjectivesController(() => surface.server()?.connection)
  const mobile = createMediaQuery("(max-width: 767px)")
  const desktop = createMemo(() => platform.platform === "desktop")

  const pinchZoom = createOptimisticSetting({
    source: () => (desktop() && "getPinchZoomEnabled" in platform) || undefined,
    initial: false,
    initialMeta: undefined,
    load: async () => ({ value: (await platform.getPinchZoomEnabled?.()) ?? false, meta: undefined }),
    write: (checked) => platform.setPinchZoomEnabled?.(checked),
  })

  const spellcheck = createOptimisticSetting({
    source: () => (desktop() && "getSpellcheckEnabled" in platform) || undefined,
    initial: true,
    initialMeta: undefined,
    load: async () => ({ value: (await platform.getSpellcheckEnabled?.()) ?? true, meta: undefined }),
    write: (checked) => platform.setSpellcheckEnabled?.(checked),
  })

  const GeneralSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.general")}</h3>
      <SettingsList>
        <InterfaceModeSetting />
        <LanguageSetting />

        <WorkspaceDestinationSetting />
        <AutoApprovePermissionsSetting />

        <SettingsRow
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRow>

        <FollowUpBehaviorSetting />

        <Show when={desktop()}>
          <SettingsRow
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.value()} onChange={pinchZoom.select} />
            </div>
          </SettingsRow>
          <SettingsRow
            title={language.t("settings.general.row.spellcheck.title")}
            description={language.t("settings.general.row.spellcheck.description")}
          >
            <div data-action="settings-spellcheck">
              <Switch checked={spellcheck.value()} onChange={spellcheck.select} />
            </div>
          </SettingsRow>
        </Show>

        <PluginSettingsSections page="general" section="general" />

        <Show when={mobile()}>
          <SettingsRow
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRow>
        </Show>
      </SettingsList>
    </div>
  )

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.preferences")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.preferences.description")}
            </span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <GeneralSection />

        <section class="settings-section" aria-label={language.t("settings.timeline.title")}>
          <h3 class="settings-section-title">{language.t("settings.timeline.title")}</h3>
          <SettingsList>
            <div class="border-b-[0.5px] border-v2-border-border-base py-5">
              <TimelineDetailControl
                value={settings.general.timelineDetail()}
                onChange={settings.general.setTimelineDetail}
              />
            </div>
            <TimelineWidthSetting />
            <BackgroundActivitySetting />
            <SettingsRow
              title={language.t("settings.timeline.row.turnDiffs.title")}
              description={language.t("settings.timeline.row.turnDiffs.description")}
            >
              <div data-action="settings-show-turn-diffs">
                <Switch
                  checked={settings.general.showTurnDiffs()}
                  onChange={(checked) => settings.general.setShowTurnDiffs(checked)}
                />
              </div>
            </SettingsRow>
          </SettingsList>
        </section>

        <ObjectivesProtocolSection controller={objectivesController} />

        <PluginSettingsSections page="general" />
      </div>
    </>
  )
}
