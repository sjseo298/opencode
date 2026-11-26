import { Component, Show, createEffect, createMemo, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { Icon } from "@opencode/ui/icon"
import { TimelineDetailControl } from "@/settings/timeline-detail"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ExternalLink } from "@/runtime/platform/external-link"
import { PluginSettingsSections } from "@/runtime/plugin/settings-page-view"
import {
  type BackgroundActivity,
  type FollowUpBehavior,
  type QuestionSubmitKey,
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
  createServerCompactionModelController,
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

export const ShellSetting: Component<{ controller: ShellSettingsController }> = (props) => {
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
        data-action="settings-shell"
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
  const language = useLanguage()

  const options = createMemo(() => {
    const current = props.controller.current()

    const base = [
      { id: "active", value: "", name: language.t("settings.compactionModel.activeDefault") },
      ...props.controller.models().map((m) => ({ id: m.id, value: m.id, name: m.name })),
    ]

    if (current && !base.some((opt) => opt.value === current)) {
      return [...base, { id: current, value: current, name: current }]
    }

    return base
  })

  return (
    <SettingsRow
      title={language.t("settings.compactionModel.title")}
      description={language.t("settings.compactionModel.description")}
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
  const language = useLanguage()

  const defaultSuffix = () => ` ${language.t("settings.objectives.defaultBadge")}`

  const numSelectOptions = (values: number[], defaultVal: number, suffix = "") =>
    values.map((v) => ({
      value: v,
      label: `${v}${suffix}${v === defaultVal ? defaultSuffix() : ""}`,
    }))

  const maxActionsOptions = createMemo(() =>
    numSelectOptions(
      [5, 10, 15, 20, 25, 30, 50],
      DEFAULT_OBJECTIVES_UI_CONFIG.max_actions_without_sync,
      ` ${language.t("settings.objectives.suffix.actions")}`,
    ),
  )

  const repeatedOptions = createMemo(() =>
    numSelectOptions(
      [1, 2, 3, 4, 5],
      DEFAULT_OBJECTIVES_UI_CONFIG.repeated_action_warning_threshold,
      ` ${language.t("settings.objectives.suffix.repetitions")}`,
    ),
  )

  const attachThresholdOptions = createMemo(() =>
    [0.55, 0.6, 0.65, 0.68, 0.72, 0.75, 0.8, 0.85].map((v) => ({
      value: v,
      label: `${v.toFixed(2)}${v === DEFAULT_OBJECTIVES_UI_CONFIG.search_attach_threshold ? defaultSuffix() : ""}`,
    })),
  )

  const novelThresholdOptions = createMemo(() =>
    [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((v) => ({
      value: v,
      label: `${v.toFixed(2)}${v === DEFAULT_OBJECTIVES_UI_CONFIG.search_novel_threshold ? defaultSuffix() : ""}`,
    })),
  )

  const findingCharsOptions = createMemo(() =>
    numSelectOptions(
      [5, 10, 15, 20, 30],
      DEFAULT_OBJECTIVES_UI_CONFIG.finding_min_chars,
      ` ${language.t("settings.objectives.suffix.chars")}`,
    ),
  )

  const delegationCharsOptions = createMemo(() =>
    numSelectOptions(
      [5, 10, 15, 20, 30],
      DEFAULT_OBJECTIVES_UI_CONFIG.delegation_justification_min_chars,
      ` ${language.t("settings.objectives.suffix.chars")}`,
    ),
  )

  const freshPercentOptions = createMemo(() =>
    numSelectOptions([20, 25, 30, 35, 40, 50, 60], DEFAULT_OBJECTIVES_UI_CONFIG.fresh_session_percent_threshold, "%"),
  )

  const freshTokensOptions = createMemo(() =>
    [15000, 20000, 30000, 45000, 60000, 100000].map((v) => ({
      value: v,
      label: `${v.toLocaleString(language.intl())} ${language.t("settings.objectives.suffix.tokens")}${v === DEFAULT_OBJECTIVES_UI_CONFIG.fresh_session_tokens_threshold ? defaultSuffix() : ""}`,
    })),
  )

  const cooldownOptions = createMemo(() =>
    [0, 1000, 2000, 3000, 5000, 10000].map((v) => ({
      value: v,
      label: `${v} ${language.t("settings.objectives.suffix.ms")}${v === DEFAULT_OBJECTIVES_UI_CONFIG.relevance_cooldown_ms ? defaultSuffix() : ""}`,
    })),
  )

  const primaryCompactionOptions = createMemo(() =>
    numSelectOptions([70, 75, 80, 85, 90, 95], DEFAULT_OBJECTIVES_UI_CONFIG.primary_pre_compaction_threshold, "%"),
  )

  const subagentCompactionOptions = createMemo(() =>
    numSelectOptions([75, 80, 85, 90, 95], DEFAULT_OBJECTIVES_UI_CONFIG.subagent_pre_compaction_threshold, "%"),
  )

  const minSubagentBudgetOptions = createMemo(() =>
    [8000, 12000, 16000, 24000, 32000, 48000].map((v) => ({
      value: v,
      label: `${v.toLocaleString(language.intl())} ${language.t("settings.objectives.suffix.tokens")}${v === DEFAULT_OBJECTIVES_UI_CONFIG.min_subagent_budget ? defaultSuffix() : ""}`,
    })),
  )

  const subagentModelOptions = createMemo(() => {
    const current = props.controller.current().subagent_model ?? ""

    const base = [
      { id: "default", value: "", name: language.t("settings.objectives.row.subagentModel.default") },
      ...props.controller.models().map((m) => ({ id: m.id, value: m.id, name: m.name })),
    ]

    if (current && !base.some((opt) => opt.value === current)) {
      return [...base, { id: current, value: current, name: current }]
    }

    return base
  })

  const [slotSavePath, setSlotSavePath] = createSignal(props.controller.current().llamacpp_slot_save_path ?? "")

  createEffect(() => {
    setSlotSavePath(props.controller.current().llamacpp_slot_save_path ?? "")
  })

  const saveSlotPath = () => {
    const trimmed = slotSavePath().trim()

    props.controller.update("llamacpp_slot_save_path", trimmed)
  }

  return (
    <section class="settings-section" aria-label={language.t("settings.objectives.section.title")}>
      <div class="flex items-center justify-between gap-2">
        <h3 class="settings-section-title">{language.t("settings.objectives.section.title")}</h3>
        <Button size="small" variant="ghost" onClick={() => props.controller.resetDefaults()}>
          {language.t("settings.objectives.resetDefaults")}
        </Button>
      </div>
      <SettingsList>
        <SettingsRow
          title={language.t("settings.objectives.row.maxActions.title")}
          description={language.t("settings.objectives.row.maxActions.description")}
        >
          <Select
            data-action="settings-objectives-max-actions-without-sync"
            options={maxActionsOptions()}
            current={
              maxActionsOptions().find((o) => o.value === props.controller.current().max_actions_without_sync) ??
              maxActionsOptions()[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("max_actions_without_sync", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.repeatedAction.title")}
          description={language.t("settings.objectives.row.repeatedAction.description")}
        >
          <Select
            data-action="settings-objectives-repeated-action-threshold"
            options={repeatedOptions()}
            current={
              repeatedOptions().find((o) => o.value === props.controller.current().repeated_action_warning_threshold) ??
              repeatedOptions()[1]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("repeated_action_warning_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.searchAttach.title")}
          description={language.t("settings.objectives.row.searchAttach.description")}
        >
          <Select
            data-action="settings-objectives-search-attach-threshold"
            options={attachThresholdOptions()}
            current={
              attachThresholdOptions().find((o) => o.value === props.controller.current().search_attach_threshold) ??
              attachThresholdOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("search_attach_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.searchNovel.title")}
          description={language.t("settings.objectives.row.searchNovel.description")}
        >
          <Select
            data-action="settings-objectives-search-novel-threshold"
            options={novelThresholdOptions()}
            current={
              novelThresholdOptions().find((o) => o.value === props.controller.current().search_novel_threshold) ??
              novelThresholdOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("search_novel_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.findingMinChars.title")}
          description={language.t("settings.objectives.row.findingMinChars.description")}
        >
          <Select
            data-action="settings-objectives-finding-min-chars"
            options={findingCharsOptions()}
            current={
              findingCharsOptions().find((o) => o.value === props.controller.current().finding_min_chars) ??
              findingCharsOptions()[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("finding_min_chars", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.delegationMinChars.title")}
          description={language.t("settings.objectives.row.delegationMinChars.description")}
        >
          <Select
            data-action="settings-objectives-delegation-min-chars"
            options={delegationCharsOptions()}
            current={
              delegationCharsOptions().find(
                (o) => o.value === props.controller.current().delegation_justification_min_chars,
              ) ?? delegationCharsOptions()[1]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("delegation_justification_min_chars", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.freshPercent.title")}
          description={language.t("settings.objectives.row.freshPercent.description")}
        >
          <Select
            data-action="settings-objectives-fresh-session-percent"
            options={freshPercentOptions()}
            current={
              freshPercentOptions().find((o) => o.value === props.controller.current().fresh_session_percent_threshold) ??
              freshPercentOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("fresh_session_percent_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.freshTokens.title")}
          description={language.t("settings.objectives.row.freshTokens.description")}
        >
          <Select
            data-action="settings-objectives-fresh-session-tokens"
            options={freshTokensOptions()}
            current={
              freshTokensOptions().find((o) => o.value === props.controller.current().fresh_session_tokens_threshold) ??
              freshTokensOptions()[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("fresh_session_tokens_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.relevanceCooldown.title")}
          description={language.t("settings.objectives.row.relevanceCooldown.description")}
        >
          <Select
            data-action="settings-objectives-relevance-cooldown-ms"
            options={cooldownOptions()}
            current={
              cooldownOptions().find((o) => o.value === props.controller.current().relevance_cooldown_ms) ??
              cooldownOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("relevance_cooldown_ms", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.primaryCompaction.title")}
          description={language.t("settings.objectives.row.primaryCompaction.description")}
        >
          <Select
            data-action="settings-objectives-primary-compaction-threshold"
            options={primaryCompactionOptions()}
            current={
              primaryCompactionOptions().find(
                (o) => o.value === props.controller.current().primary_pre_compaction_threshold,
              ) ?? primaryCompactionOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("primary_pre_compaction_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.subagentCompaction.title")}
          description={language.t("settings.objectives.row.subagentCompaction.description")}
        >
          <Select
            data-action="settings-objectives-subagent-compaction-threshold"
            options={subagentCompactionOptions()}
            current={
              subagentCompactionOptions().find(
                (o) => o.value === props.controller.current().subagent_pre_compaction_threshold,
              ) ?? subagentCompactionOptions()[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("subagent_pre_compaction_threshold", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.minSubagentBudget.title")}
          description={language.t("settings.objectives.row.minSubagentBudget.description")}
        >
          <Select
            data-action="settings-objectives-min-subagent-budget"
            options={minSubagentBudgetOptions()}
            current={
              minSubagentBudgetOptions().find((o) => o.value === props.controller.current().min_subagent_budget) ??
              minSubagentBudgetOptions()[2]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => String(o.value)}
            label={(o) => o.label}
            onSelect={(o) => o && props.controller.update("min_subagent_budget", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.subagentModel.title")}
          description={language.t("settings.objectives.row.subagentModel.description")}
        >
          <Select
            data-action="settings-objectives-subagent-model"
            options={subagentModelOptions()}
            current={
              subagentModelOptions().find((o) => o.value === (props.controller.current().subagent_model ?? "")) ??
              subagentModelOptions()[0]
            }
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(o) => o && props.controller.update("subagent_model", o.value)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.embeddingsEnabled.title")}
          description={language.t("settings.objectives.row.embeddingsEnabled.description")}
        >
          <div data-action="settings-objectives-embeddings-enabled">
            <Switch
              checked={props.controller.current().embeddings_enabled}
              onChange={(checked) => props.controller.update("embeddings_enabled", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.unattended.title")}
          description={language.t("settings.objectives.row.unattended.description")}
        >
          <div data-action="settings-objectives-unattended">
            <Switch
              checked={props.controller.current().unattended}
              onChange={(checked) => props.controller.update("unattended", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.kvOffload.title")}
          description={language.t("settings.objectives.row.kvOffload.description")}
        >
          <div data-action="settings-objectives-llamacpp-kv-offload">
            <Switch
              checked={props.controller.current().llamacpp_kv_offload}
              onChange={(checked) => props.controller.update("llamacpp_kv_offload", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.objectives.row.slotSavePath.title")}
          description={language.t("settings.objectives.row.slotSavePath.description")}
        >
          <div class="flex items-center gap-1.5">
            <TextInput
              data-action="settings-objectives-slot-save-path"
              value={slotSavePath()}
              placeholder={language.t("settings.objectives.row.slotSavePath.placeholder")}
              onInput={(e) => setSlotSavePath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault()
                  saveSlotPath()
                }
              }}
            />
            <Button size="small" variant="outline" onClick={saveSlotPath}>
              {language.t("settings.objectives.row.slotSavePath.save")}
            </Button>
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

const QuestionSubmitKeySetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: QuestionSubmitKey; label: string }[] => [
    { value: "enter", label: formatKeybind("enter", language.t) },
    { value: "mod+enter", label: formatKeybind("mod+enter", language.t) },
  ])

  return (
    <SettingsRow
      title={language.t("settings.general.row.questionSubmitKey.title")}
      description={language.t("settings.general.row.questionSubmitKey.description", {
        keybind: formatKeybind(settings.general.questionSubmitKey() === "enter" ? "shift+enter" : "enter", language.t),
      })}
    >
      <Select
        data-action="settings-question-submit-key"
        options={options()}
        current={options().find((option) => option.value === settings.general.questionSubmitKey())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setQuestionSubmitKey(option.value)}
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
  const compactionModelController = createServerCompactionModelController(() => surface.server()?.connection)
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
        <SettingsRow
          title={language.t("settings.general.row.sharedSidePanel.title")}
          description={language.t("settings.general.row.sharedSidePanel.description")}
        >
          <div data-action="settings-shared-side-panel">
            <Switch
              checked={settings.general.sharedSidePanel()}
              onChange={(checked) => settings.general.setSharedSidePanel(checked)}
            />
          </div>
        </SettingsRow>
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
        <CompactionModelSetting controller={compactionModelController} />

        <QuestionSubmitKeySetting />

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
          <div class="settings-tab-header-actions">
            <ExternalLink
              data-action="settings-help-feedback"
              href="https://opencode.ai/desktop-feedback"
              class="inline-flex items-center gap-1.5 text-13-regular text-v2-text-text-muted no-underline hover:text-v2-text-text-base hover:underline"
            >
              {language.t("settings.helpFeedback")}
              <Icon name="arrow-up-right" size="small" />
            </ExternalLink>
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
              title={language.t("settings.timeline.row.foldUserMessages.title")}
              description={language.t("settings.timeline.row.foldUserMessages.description")}
            >
              <div data-action="settings-fold-user-messages">
                <Switch
                  checked={settings.general.foldUserMessages()}
                  onChange={(checked) => settings.general.setFoldUserMessages(checked)}
                  hideLabel
                >
                  {language.t("settings.timeline.row.foldUserMessages.title")}
                </Switch>
              </div>
            </SettingsRow>
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
            <SettingsRow
              title={language.t("settings.timeline.row.wrapCodeBlocks.title")}
              description={language.t("settings.timeline.row.wrapCodeBlocks.description")}
            >
              <div data-action="settings-wrap-code-blocks">
                <Switch
                  checked={settings.general.wrapCodeBlocks()}
                  onChange={(checked) => settings.general.setWrapCodeBlocks(checked)}
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
