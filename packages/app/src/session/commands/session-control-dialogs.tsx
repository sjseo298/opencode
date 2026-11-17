import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import type { ModelSelection } from "@/providers/models/selection"
import { getDynamicModelContextLimit, setDynamicModelContextLimit } from "@/providers/models/context-limit"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData, useServer } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import { sessionHref } from "@/shell/routes/session"
import { useTabs } from "@/shell/tabs/tabs"
import { useWorkspaceLocation } from "@/workspaces/location"

export function parseTokenCount(val: string): number | undefined {
  const clean = val.trim().toLowerCase()

  if (!clean) return undefined

  if (clean.endsWith("k")) {
    const num = Number.parseFloat(clean.slice(0, -1))

    return Number.isFinite(num) && num > 0 ? Math.round(num * 1000) : undefined
  }

  if (clean.endsWith("m")) {
    const num = Number.parseFloat(clean.slice(0, -1))

    return Number.isFinite(num) && num > 0 ? Math.round(num * 1_000_000) : undefined
  }

  const num = Number.parseInt(clean.replace(/[,._]/g, ""), 10)

  return Number.isFinite(num) && num > 0 ? num : undefined
}

export async function executeRewindSteps(input: {
  sessionID: string
  steps: number
  sdk: ReturnType<typeof useServerSDK>
  data: ReturnType<typeof useData>
  language: ReturnType<typeof useLanguage>
}) {
  try {
    await input.sdk.api.session.interrupt({ sessionID: input.sessionID })
    await input.sdk.api.experimental.session.wait({ sessionID: input.sessionID })
    const allMessages = input.data.session.message.list(input.sessionID) ?? []
    const revertID = input.data.session.get(input.sessionID)?.revert?.messageID

    const messages = revertID
      ? allMessages.slice(
          0,
          Math.max(
            0,
            allMessages.findIndex((m) => m.id === revertID),
          ),
        )
      : allMessages

    const lastUserIndex = messages.findLastIndex((m) => m.type === "user" && Boolean(m.text.trim()))
    const scopeMessages = lastUserIndex === -1 ? messages : messages.slice(lastUserIndex + 1)
    const assistantSteps = scopeMessages.filter((m) => m.type === "assistant")

    if (assistantSteps.length === 0) {
      showToast({ variant: "error", title: input.language.t("dialog.rewind.toast.none") })

      return
    }

    const actualCount = Math.min(input.steps, assistantSteps.length)
    const target = assistantSteps[assistantSteps.length - actualCount]

    if (!target) return
    await input.sdk.api.session.revert.stage({ sessionID: input.sessionID, messageID: target.id })
    await input.sdk.api.session.revert.commit({ sessionID: input.sessionID, resume: true })
    showToast({
      variant: "default",
      title: input.language.t("dialog.rewind.toast.started", { count: String(actualCount) }),
    })
  } catch (cause: unknown) {
    showToast({
      variant: "error",
      title: formatServerError(cause, input.language.t, input.language.t("common.requestFailed")),
    })
  }
}

export function DialogRewindSteps(props: { sessionID: string }) {
  const sdk = useServerSDK()
  const data = useData()
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal("1")
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    if (busy()) return
    const trimmed = value().trim()
    const parsed = trimmed === "" ? 1 : Number.parseInt(trimmed, 10)

    if (!Number.isFinite(parsed) || parsed < 1) {
      showToast({ variant: "error", title: language.t("dialog.rewind.toast.invalid") })

      return
    }

    setBusy(true)
    dialog.close()
    await executeRewindSteps({
      sessionID: props.sessionID,
      steps: parsed,
      sdk,
      data,
      language,
    })
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.rewind.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-3 px-5 pb-5 pt-2">
          <div class="text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted">
            {language.t("dialog.rewind.description")}
          </div>
          <TextInput
            value={value()}
            placeholder={language.t("dialog.rewind.placeholder")}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button size="small" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="submit" disabled={busy()} onClick={() => void submit()}>
              {language.t("dialog.rewind.confirm")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export { getDynamicModelContextLimit }

export async function applyModelContextLimit(input: {
  modelKey: string
  limit: number
  sdk: ReturnType<typeof useServerSDK>
  language: ReturnType<typeof useLanguage>
}) {
  setDynamicModelContextLimit(input.modelKey, input.limit)

  showToast({
    variant: "success",
    title: input.language.t("dialog.contextLimit.toast.applied", {
      model: input.modelKey,
      limit: input.limit.toLocaleString(),
    }),
  })
}

export function DialogSetContextLimit(props: { activeModelKey?: string }) {
  const sdk = useServerSDK()
  const data = useData()
  const workspace = useWorkspaceLocation()
  const dialog = useDialog()
  const language = useLanguage()

  const models = createMemo(() => {
    const list = data.location.model.list(workspace().ref) ?? []

    return list.map((m) => ({
      key: `${m.providerID}/${m.id}`,
      label: `${m.providerID}/${m.name || m.id}`,
      defaultLimit: m.limit?.context,
    }))
  })

  const [selectedModel, setSelectedModel] = createSignal(
    props.activeModelKey ?? models()[0]?.key ?? "",
  )

  const currentDefault = createMemo(() => {
    const key = selectedModel()

    return getDynamicModelContextLimit(key) ?? models().find((m) => m.key === key)?.defaultLimit
  })

  const [limitText, setLimitText] = createSignal(
    currentDefault() ? String(currentDefault()) : "128000",
  )

  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    if (busy()) return
    const targetModel = selectedModel().trim()

    if (!targetModel) {
      showToast({ variant: "error", title: language.t("dialog.contextLimit.toast.noModel") })

      return
    }

    const parsed = parseTokenCount(limitText())

    if (!parsed) {
      showToast({ variant: "error", title: language.t("dialog.contextLimit.toast.invalid") })

      return
    }

    setBusy(true)
    dialog.close()
    await applyModelContextLimit({
      modelKey: targetModel,
      limit: parsed,
      sdk,
      language,
    })
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.contextLimit.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-3 px-5 pb-5 pt-2">
          <Show when={models().length > 0}>
            <div class="flex flex-col gap-1">
              <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                {language.t("dialog.contextLimit.modelLabel")}
              </span>
              <Select
                options={models()}
                current={models().find((m) => m.key === selectedModel()) ?? models()[0]}
                value={(m) => m.key}
                label={(m) => m.label}
                onSelect={(m) => {
                  if (!m) return
                  setSelectedModel(m.key)

                  if (m.defaultLimit) setLimitText(String(m.defaultLimit))
                }}
              />
            </div>
          </Show>
          <div class="flex flex-col gap-1">
            <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
              {language.t("dialog.contextLimit.limitLabel")}
            </span>
            <TextInput
              value={limitText()}
              placeholder={language.t("dialog.contextLimit.placeholder")}
              onInput={(e) => setLimitText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
          </div>
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button size="small" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="submit" disabled={busy()} onClick={() => void submit()}>
              {language.t("dialog.contextLimit.confirm")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function DialogChangeDirectory(props: { sessionID: string; currentDirectory: string }) {
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [directory, setDirectory] = createSignal(props.currentDirectory)
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    const target = directory().trim()

    if (!target || busy()) return
    setBusy(true)

    try {
      await sdk.api.session.move({ sessionID: props.sessionID, directory: target })
      dialog.close()
      showToast({
        variant: "success",
        title: language.t("dialog.cd.toast.moved", { directory: target }),
      })
    } catch (cause: unknown) {
      setBusy(false)
      showToast({
        variant: "error",
        title: formatServerError(cause, language.t, language.t("common.requestFailed")),
      })
    }
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.cd.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-3 px-5 pb-5 pt-2">
          <div class="text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted">
            {language.t("dialog.cd.description")}
          </div>
          <TextInput
            value={directory()}
            placeholder={language.t("dialog.cd.placeholder")}
            onInput={(e) => setDirectory(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button size="small" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="submit" disabled={busy() || !directory().trim()} onClick={() => void submit()}>
              {language.t("dialog.cd.confirm")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function DialogRenameSession(props: { sessionID: string; currentTitle?: string }) {
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [title, setTitle] = createSignal(props.currentTitle ?? "")
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    const trimmed = title().trim()

    if (!trimmed || busy()) return
    setBusy(true)

    try {
      await sdk.api.session.update({ sessionID: props.sessionID, title: trimmed })
      dialog.close()
      showToast({
        variant: "success",
        title: language.t("dialog.renameSession.toast.updated"),
      })
    } catch (cause: unknown) {
      setBusy(false)
      showToast({
        variant: "error",
        title: formatServerError(cause, language.t, language.t("common.requestFailed")),
      })
    }
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.renameSession.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-3 px-5 pb-5 pt-2">
          <TextInput
            value={title()}
            placeholder={language.t("dialog.renameSession.placeholder")}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div class="flex items-center justify-end gap-2 pt-1">
            <Button size="small" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="submit" disabled={busy() || !title().trim()} onClick={() => void submit()}>
              {language.t("dialog.renameSession.confirm")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function DialogDeleteSession(props: { sessionID: string; title?: string }) {
  const sdk = useServerSDK()
  const server = useServer()
  const tabs = useTabs()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const confirmDelete = async () => {
    if (busy()) return
    setBusy(true)

    try {
      await sdk.api.session.remove({ sessionID: props.sessionID })
      tabs.removeSessionTab({ server: server.key, sessionId: props.sessionID })
      dialog.close()
      navigate("/")
      showToast({
        variant: "default",
        title: language.t("dialog.deleteSession.toast.deleted"),
      })
    } catch (cause: unknown) {
      setBusy(false)
      showToast({
        variant: "error",
        title: formatServerError(cause, language.t, language.t("common.requestFailed")),
      })
    }
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.deleteSession.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-4 px-5 pb-5 pt-2">
          <div class="text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted" dir="auto">
            {language.t("dialog.deleteSession.description", {
              title: props.title || props.sessionID,
            })}
          </div>
          <div class="flex items-center justify-end gap-2">
            <Button size="small" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button size="small" variant="danger" disabled={busy()} onClick={() => void confirmDelete()}>
              {language.t("dialog.deleteSession.confirm")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function DialogSwitchSession() {
  const data = useData()
  const server = useServer()
  const tabs = useTabs()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")

  const sessions = createMemo(() => {
    const q = query().trim().toLowerCase()
    const list = data.session.list().filter((s) => !s.parentID)

    if (!q) return list.slice(0, 50)

    return list
      .filter(
        (s) =>
          (s.title ?? "").toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.location.directory.toLowerCase().includes(q),
      )
      .slice(0, 50)
  })

  const selectSession = (sessionID: string) => {
    tabs.addSessionTab({ server: server.key, sessionId: sessionID })
    dialog.close()
    navigate(sessionHref(server.key, sessionID))
  }

  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.sessions.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-3 px-5 pb-5 pt-2">
          <TextInput
            value={query()}
            placeholder={language.t("dialog.sessions.placeholder")}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                const first = sessions()[0]

                if (first) {
                  e.preventDefault()
                  selectSession(first.id)
                }
              }
            }}
          />
          <Show
            when={sessions().length > 0}
            fallback={
              <div class="py-8 text-center text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted">
                {language.t("dialog.sessions.empty")}
              </div>
            }
          >
            <MenuScroll class="max-h-[360px]" viewportClass="flex flex-col gap-1.5 p-0.5">
              <For each={sessions()}>
                {(s) => (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 py-2.5 text-start hover:bg-v2-background-bg-layer-02 transition-colors"
                    onClick={() => selectSession(s.id)}
                  >
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span
                        class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base truncate"
                        dir="auto"
                      >
                        {s.title || s.id}
                      </span>
                      <span class="font-mono text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-muted truncate">
                        {s.location.directory}
                      </span>
                    </div>
                  </button>
                )}
              </For>
            </MenuScroll>
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function DialogSelectVariant(props: { model: ModelSelection }) {
  const dialog = useDialog()
  const language = useLanguage()

  const variants = createMemo(() => props.model.variant.list())
  const current = createMemo(() => props.model.variant.current())

  const choose = (value: string | undefined) => {
    props.model.variant.set(value)
    dialog.close()
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.variant.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-2 px-5 pb-5 pt-2">
          <Show
            when={variants().length > 0}
            fallback={
              <div class="py-6 text-center text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted">
                {language.t("dialog.variant.empty")}
              </div>
            }
          >
            <button
              type="button"
              class="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-start transition-colors"
              classList={{
                "border-v2-border-border-strong bg-v2-background-bg-layer-02": current() === undefined,
                "border-v2-border-border-base bg-v2-background-bg-layer-01 hover:bg-v2-background-bg-layer-02":
                  current() !== undefined,
              }}
              onClick={() => choose(undefined)}
            >
              <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                {language.t("dialog.variant.default")}
              </span>
              <Show when={current() === undefined}>
                <Badge>active</Badge>
              </Show>
            </button>
            <For each={variants()}>
              {(v) => (
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-start transition-colors"
                  classList={{
                    "border-v2-border-border-strong bg-v2-background-bg-layer-02": current() === v,
                    "border-v2-border-border-base bg-v2-background-bg-layer-01 hover:bg-v2-background-bg-layer-02":
                      current() !== v,
                  }}
                  onClick={() => choose(v)}
                >
                  <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                    {v}
                  </span>
                  <Show when={current() === v}>
                    <Badge>active</Badge>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}

