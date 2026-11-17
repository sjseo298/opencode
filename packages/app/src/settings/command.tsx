import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettingsSurface } from "./surface"
import type { SettingsRootTab } from "./surface"

export const settingsOpenCommand = { id: "settings.open", keybind: "mod+comma" }

export function useSettingsDialog(defaultValue?: SettingsRootTab) {
  const settings = useSettingsSurface()

  return () => settings.open(defaultValue)
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog()
  const showThemes = useSettingsDialog("appearance")

  command.register("settings", () => [
    {
      ...settingsOpenCommand,
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      slash: "settings",
      onSelect: show,
    },
    {
      id: "settings.themes",
      title: language.t("command.theme.choose"),
      description: language.t("command.theme.choose.description"),
      category: language.t("command.category.settings"),
      slash: "themes",
      onSelect: showThemes,
    },
  ])

  return show
}
