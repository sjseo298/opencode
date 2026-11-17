import type { Accessor } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { showToast } from "@/shell/notifications/toast"

export function createAutoApproveControl(projectID: Accessor<string | undefined>) {
  const settings = useSettings()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const projectKey = () => projectSettingsKey(serverSDK.scope, projectID())

  const active = () => settings.permissions.autoApproves(projectKey())

  const toggle = () => {
    const project = projectKey()
    const next = !active()

    if (!project) settings.permissions.setAutoApproveDefault(next)
    else
      settings.permissions.setAutoApproveOverride(
        project,
        next === settings.permissions.autoApproveDefault() ? undefined : next,
      )

    if (!next) {
      showToast({
        title: language.t("toast.permissions.autoaccept.off.title"),
        description: language.t("toast.permissions.autoaccept.off.description"),
      })

      return
    }

    showToast({
      title: project
        ? language.t("toast.permissions.autoaccept.project.title")
        : language.t("toast.permissions.autoaccept.on.title"),
      description: project
        ? language.t("toast.permissions.autoaccept.project.description")
        : language.t("toast.permissions.autoaccept.on.description"),
    })
  }

  return {
    active,
    scoped: () => Boolean(projectKey()),
    toggle,
  }
}
