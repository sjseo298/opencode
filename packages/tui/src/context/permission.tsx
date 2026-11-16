import { createSignal } from "solid-js"
import { useConfig } from "../config"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

export type PermissionMode = "prompt" | "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const config = useConfig()
    const [override, setOverride] = createSignal<PermissionMode | undefined>()
    const current = (): PermissionMode => override() ?? (args.auto ? "autoaccept" : config.data.session.permissions)
    const set = (next: PermissionMode) => {
      setOverride(next)
      void config
        .update((draft) => {
          draft.session = { ...draft.session, permissions: next }
        })
        .catch(() => undefined)
    }
    return {
      get mode(): PermissionMode {
        return current()
      },
      set,
      toggle(): PermissionMode {
        const next: PermissionMode = current() === "autoaccept" ? "prompt" : "autoaccept"
        set(next)
        return next
      },
    }
  },
})
