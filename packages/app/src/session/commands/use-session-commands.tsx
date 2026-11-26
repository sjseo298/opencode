import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, type JSX } from "solid-js"
import { createEventListener } from "@solid-primitives/event-listener"
import { useCommand, type CommandOption } from "@/shell/commands/command"
import { adjacentTabKey } from "@/shell/titlebar/tab-order"
import { useDialog } from "@opencode/ui/context/dialog"
import { previewSelectedLines } from "@opencode/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection } from "@/workspaces/files/model"
import { useLanguage } from "@/runtime/i18n/language"
import { useComposerState } from "@/composer/persistence"
import { useServerSDK } from "@/runtime/server/client"
import { useData, useServer } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { useSettings } from "@/settings/model"
import { createAutoApproveControl } from "@/settings/auto-approve"
import { showToast } from "@/shell/notifications/toast"
import { useSessionExporter } from "@/session/commands/export-session"
import { usePlatform } from "@/runtime/platform/platform"
import type { SessionModel } from "@/session/model"
import type { SessionRevert } from "@/session/revert"
import { usePluginClaims, usePluginScoped } from "@/runtime/plugin/commands"
import type { Region } from "@/runtime/plugin/panels"
import { sideTabShortcuts } from "@/runtime/plugin/closed-tabs"
import { useTabs } from "@/shell/tabs/tabs"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import { useQueryClient } from "@tanstack/solid-query"
import {
  createCloseTabGuardState,
  createSessionCommandsState,
  selectCloseTabSwallowed,
  transitionCloseTabGuard,
  transitionSessionCommands,
  type CloseTabGuardEvent,
  type SessionCommandsEffect,
  type SessionCommandsEvent,
  type SessionDialogKind,
} from "@/session/commands/machine"

// Shared by every dispatch: pointer, focus and key events arrive constantly while the guard is disarmed.
const POINTER_DOWN: CloseTabGuardEvent = { type: "pointer.down" }

const FOCUS_IN: CloseTabGuardEvent = { type: "focus.in" }

const WINDOW_BLUR: CloseTabGuardEvent = { type: "window.blur" }

type SessionCommandSource = {
  identity: SessionModel["identity"]
  data: Pick<SessionModel["data"], "info" | "objectives">
  history: Pick<SessionModel["history"], "visibleUserMessages">
  layout: SessionModel["layout"]
}

export type SessionCommandContext = {
  session: SessionCommandSource
  region: Region
  background: {
    blocking: () => boolean
    move: () => Promise<void>
  }
  navigateMessageByOffset: (offset: number) => void
  jumpToMessage: (id: string) => void
  revert: Pick<SessionRevert, "undo" | "redo" | "canUndo" | "canRedo">
  focusInput: () => void
  // The composer's model, which a compaction runs with.
  model: () => { id: string; providerID: string; variant?: string } | undefined
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

// Loads a dialog's chunk and returns its renderer.
async function loadDialog(kind: SessionDialogKind, context: SessionCommandContext): Promise<() => JSX.Element> {
  if (kind === "jump") {
    const { DialogJumpToMessage } = await import("./dialog-jump-to-message")

    return () => <DialogJumpToMessage session={context.session} onJump={context.jumpToMessage} />
  }

  if (kind === "fork") {
    const { DialogFork } = await import("@/session/commands/fork-dialog")

    return () => <DialogFork />
  }

  if (kind === "palette") {
    const { DialogCommandPalette } = await import("@/shell/commands/dialog")

    return () => <DialogCommandPalette />
  }

  if (kind === "plan") {
    const { DialogPlanApproval } = await import("@/session/objectives/plan-approval-dialog")

    return () => (
      <DialogPlanApproval
        sessionID={context.session.identity.params.id ?? ""}
        po={context.session.data.objectives()}
        onRefine={context.focusInput}
      />
    )
  }

  if (kind === "rewind") {
    const { DialogRewindSteps } = await import("@/session/commands/session-control-dialogs")

    return () => <DialogRewindSteps sessionID={context.session.identity.params.id ?? ""} />
  }

  if (kind === "context-limit") {
    const { DialogSetContextLimit } = await import("@/session/commands/session-control-dialogs")
    const currentModel = context.model()

    return () => (
      <DialogSetContextLimit
        activeModelKey={currentModel ? `${currentModel.providerID}/${currentModel.id}` : undefined}
        sessionID={context.session.identity.params.id}
      />
    )
  }

  if (kind === "cd") {
    const { DialogChangeDirectory } = await import("@/session/commands/session-control-dialogs")

    return () => (
      <DialogChangeDirectory
        sessionID={context.session.identity.params.id ?? ""}
        currentDirectory={context.session.data.info()?.location.directory ?? ""}
      />
    )
  }

  if (kind === "rename") {
    const { DialogRenameSession } = await import("@/session/commands/session-control-dialogs")

    return () => (
      <DialogRenameSession
        sessionID={context.session.identity.params.id ?? ""}
        currentTitle={context.session.data.info()?.title}
      />
    )
  }

  if (kind === "delete") {
    const { DialogDeleteSession } = await import("@/session/commands/session-control-dialogs")

    return () => (
      <DialogDeleteSession
        sessionID={context.session.identity.params.id ?? ""}
        title={context.session.data.info()?.title}
      />
    )
  }

  if (kind === "sessions") {
    const { DialogSwitchSession } = await import("@/session/commands/session-control-dialogs")

    return () => <DialogSwitchSession />
  }

  const { DialogSelectMcp } = await import("@/providers/connect/mcp-dialog")

  return () => <DialogSelectMcp />
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const prompt = useComposerState()
  const serverSDK = useServerSDK()
  const server = useServer()
  const data = useData()
  const settings = useSettings()
  const platform = usePlatform()
  const exporter = useSessionExporter()
  const pluginScoped = usePluginScoped()
  const pluginClaims = usePluginClaims()
  const tabs = useTabs()
  const queryClient = useQueryClient()

  // The file the selected side tab shows; other tabs have no line selection.
  const activeFile = () => actions.region.selected()?.tab.file

  // Pinned tabs stay open, and hidden side-panel tabs do not claim Close Tab while the region is collapsed.
  const closableTab = () => {
    if (!actions.session.layout.view().side.opened()) return

    const entry = actions.region.selected()

    return entry && !entry.tab.pinned ? entry.key : undefined
  }

  const inSide = actions.region.focus
  // ⌘T inside the side region opens one of its tabs, unless the focused panel binds the key itself there.
  const sideKey = (event: KeyboardEvent) => inSide(event) && !pluginClaims(event)

  // As in a browser, ⌘⇧T reopens whichever tab closed last, side or session.
  const reopensSideTab = () => {
    const side = actions.region.lastClosedTime()

    if (side === undefined) return false
    const session = tabs.lastClosedTime()

    return session === undefined || side >= session
  }

  // ⌘W on the side panel's last tab, or on a panel with nothing left to close, closes the panel and moves focus out of
  // it, where one press too many would close the session tab; the guard swallows that press.
  const [closeGuard, setCloseGuard] = createSignal(createCloseTabGuardState())
  let settleFrame: number | undefined
  let quietTimer: ReturnType<typeof setTimeout> | undefined

  const dispatchCloseGuard = (event: CloseTabGuardEvent) => {
    const next = transitionCloseTabGuard(closeGuard(), event)

    if (next.state !== closeGuard()) setCloseGuard(next.state)
    next.effects.forEach((effect) => {
      if (effect.type === "quiet.schedule" || effect.type === "quiet.cancel") {
        clearTimeout(quietTimer)
        quietTimer = undefined

        if (effect.type === "quiet.cancel") return
        const attempt = effect.attempt
        quietTimer = setTimeout(() => {
          quietTimer = undefined
          dispatchCloseGuard({ type: "quiet.elapsed", attempt })
        }, effect.timeoutMs)

        return
      }

      if (settleFrame !== undefined) cancelAnimationFrame(settleFrame)
      settleFrame = undefined

      if (effect.type === "settle.cancel") return
      const attempt = effect.attempt
      settleFrame = requestAnimationFrame(() => {
        settleFrame = undefined
        dispatchCloseGuard({ type: "settle.completed", attempt })
      })
    })
  }

  createEventListener(document, "pointerdown", () => dispatchCloseGuard(POINTER_DOWN), { capture: true })
  createEventListener(document, "focusin", () => dispatchCloseGuard(FOCUS_IN), { capture: true })
  createEventListener(window, "blur", () => dispatchCloseGuard(WINDOW_BLUR))
  createEventListener(
    document,
    "keydown",
    (event) =>
      dispatchCloseGuard({ type: "key.down", key: event.key, matchesClose: command.matches("file.close", event) }),
    { capture: true },
  )
  createEffect(
    on(
      () => [actions.session.layout.tabKey(), actions.session.layout.view().side.opened()] as const,
      ([tabKey, sideOpened]) => dispatchCloseGuard({ type: "layout.synced", tabKey, sideOpened }),
      { defer: true },
    ),
  )
  onCleanup(() => dispatchCloseGuard({ type: "disposed" }))
  const cycleSideTabs = () => actions.session.layout.view().side.opened() && actions.region.keys().length > 1

  const sideFocused = (target: EventTarget | null) => {
    const element =
      target instanceof Element && target !== document.body && target !== document.documentElement
        ? target
        : document.activeElement

    return element instanceof Element && !!element.closest("#review-panel") && !pluginScoped(element)
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content

    if (!content) return undefined

    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const path = activeFile()

    if (!path) return false

    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const projectCommand = withCategory(language.t("command.category.project"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const [commandsState, setCommandsState] = createSignal(createSessionCommandsState())
  const jumpDialog = createUniqueId()
  onCleanup(() => dialog.close(jumpDialog))
  // Renders each dialog once its chunk has loaded.
  const dialogs: Partial<Record<SessionDialogKind, () => JSX.Element>> = {}
  let dialogTimer: ReturnType<typeof setTimeout> | undefined

  const dispatchCommands = (event: SessionCommandsEvent) => {
    const next = transitionSessionCommands(commandsState(), event)

    if (next.state !== commandsState()) setCommandsState(next.state)
    next.effects.forEach((effect) =>
      Promise.try(() => runCommandEffect(effect)).catch((cause: unknown) => console.error("[session.commands]", cause)),
    )
  }

  const runCommandEffect = (effect: SessionCommandsEffect) => {
    if (effect.type === "compact.run") {
      data.session.compact({ sessionID: effect.sessionID, model: actions.model() }).then(
        () => dispatchCommands({ type: "compact.succeeded", attempt: effect.attempt, sessionID: effect.sessionID }),
        (cause: unknown) =>
          dispatchCommands({ type: "compact.failed", attempt: effect.attempt, sessionID: effect.sessionID, cause }),
      )

      return
    }

    if (effect.type === "dialog.load") {
      const attempt = effect.attempt
      const kind = effect.kind
      clearTimeout(dialogTimer)
      dialogTimer = setTimeout(() => dispatchCommands({ type: "dialog.timed-out", attempt }), effect.timeoutMs)
      loadDialog(kind, actions).then(
        (render) => {
          dialogs[kind] = render
          dispatchCommands({ type: "dialog.loaded", attempt })
        },
        (cause: unknown) => dispatchCommands({ type: "dialog.load-failed", attempt, cause }),
      )

      return
    }

    if (effect.type === "dialog.cancel") {
      clearTimeout(dialogTimer)
      dialogTimer = undefined

      return
    }

    if (effect.type === "dialog.show") {
      const render = dialogs[effect.kind]

      if (render) dialog.show(render, undefined, effect.kind === "jump" ? jumpDialog : undefined)

      return
    }

    showToast({ title: formatServerError(effect.cause, language.t, language.t("common.requestFailed")) })
  }

  createEffect(
    on(
      () => actions.session.identity.sessionKey(),
      (sessionKey) => dispatchCommands({ type: "session.changed", sessionKey }),
      { defer: true },
    ),
  )
  onCleanup(() => dispatchCommands({ type: "disposed" }))

  const openDialog = (kind: SessionDialogKind) =>
    dispatchCommands({ type: "dialog.requested", kind, sessionKey: actions.session.identity.sessionKey() })

  const exportSession = () => {
    const sessionID = actions.session.identity.params.id

    if (sessionID) exporter.export({ server: server.key, sessionID })
  }

  const copySessionID = async () => {
    const sessionID = actions.session.identity.params.id

    if (!sessionID) return

    try {
      await (platform.writeClipboardText?.(sessionID) ?? navigator.clipboard.writeText(sessionID))
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.copied"),
        description: sessionID,
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.copyID.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.copyID.failed.description"),
      })
    }
  }

  // Root sessions only, as in the sidebar. Removing the session's tab moves the view to the next open session.
  const archivable = () => {
    const info = actions.session.data.info()

    return !!info && !info.parentID && info.time.archived === undefined
  }

  const unarchivable = () => {
    const info = actions.session.data.info()

    return !!info && !info.parentID && info.time.archived !== undefined
  }

  const invalidateSessionLists = () => {
    for (const queryKey of ["home-sessions", "inbox-sessions", "inbox-archived-sessions"]) {
      void queryClient.invalidateQueries({ queryKey: [queryKey, server.conn], exact: true })
    }
  }

  const unarchiveSession = async () => {
    const info = actions.session.data.info()

    if (!info || !unarchivable()) return

    try {
      await serverSDK.api.session.update({ sessionID: info.id, archived: false })
    } catch (cause) {
      showToast({ title: formatServerError(cause, language.t, language.t("common.requestFailed")) })

      return
    }

    invalidateSessionLists()
  }

  const archiveSession = async () => {
    const info = actions.session.data.info()

    if (!info || !archivable()) return

    try {
      await serverSDK.api.session.update({ sessionID: info.id, archived: true })
    } catch (cause) {
      showToast({ title: formatServerError(cause, language.t, language.t("common.requestFailed")) })

      return
    }

    invalidateSessionLists()

    notifySessionTabsRemoved({ server: server.key, directory: info.location.directory, sessionIDs: [info.id] })
  }

  const copyProjectID = async () => {
    const projectID = actions.session.data.info()?.projectID

    if (!projectID) return

    try {
      await (platform.writeClipboardText?.(projectID) ?? navigator.clipboard.writeText(projectID))
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.copied"),
        description: projectID,
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.project.copyID.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.project.copyID.failed.description"),
      })
    }
  }

  const openFile = () => openDialog("palette")

  // In the pane holding focus; the region itself, or a key a native page handed over, means the selected tab's pane.
  const focusedPane = () => {
    const pane = document.activeElement?.closest("[data-pane-content]")?.getAttribute("data-pane-content")

    return pane === "side" || pane === "split" ? pane : undefined
  }

  // With nothing left to close, ⌘W closes the side panel itself, as an editor closes the focused pane before the window.
  const closeTab = () => {
    if (actions.region.closeNewTab(focusedPane())) {
      const panel = document.getElementById("review-panel")

      // A launcher row that held focus is gone; focus stays in the panel so closing it next returns focus. Closing the
      // strip's last New tab closes the panel too, which already gave focus back.
      if (panel && actions.session.layout.view().side.opened() && !panel.contains(document.activeElement))
        panel.focus({ preventScroll: true, focusVisible: false })

      return
    }

    const tab = closableTab()

    if (tab) return actions.region.close(tab)
    actions.region.toggle()
  }

  const openSideTab = () => actions.region.openNewTab(focusedPane())

  const selectAdjacentSideTab = (offset: -1 | 1) => {
    const key = adjacentTabKey(actions.region.keys(), actions.region.active(), offset)

    if (key) selectSideTab(key)
  }

  const selectSideTab = (key: string) => {
    actions.region.select(key)

    const panel = document.getElementById("review-panel")

    if (!panel) return

    const active = document.activeElement

    if (
      active instanceof HTMLElement &&
      panel.contains(active) &&
      !active.closest('[role="tab"][aria-selected="false"], [inert], .hidden')
    )
      return
    ;(panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? panel).focus({ preventScroll: true })
  }

  const addSelection = () => {
    const path = activeFile()

    if (!path) return

    const range = file.selectedLines(path)

    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })

      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const chooseMcp = () => openDialog("mcp")

  const autoApprove = createAutoApproveControl(() => actions.session.data.info()?.projectID)
  const autoAccepting = autoApprove.active
  const toggleAutoAccept = autoApprove.toggle

  const undo = actions.revert.undo
  const redo = actions.revert.redo

  const compact = () => {
    const sessionID = actions.session.identity.params.id

    if (sessionID) dispatchCommands({ type: "compact.requested", sessionID })
  }

  const fork = () => {
    if (actions.session.identity.params.id) openDialog("fork")
  }

  const rewindSteps = async (input?: string) => {
    const sessionID = actions.session.identity.params.id

    if (!sessionID) return
    const trimmed = input?.trim()

    if (!trimmed) {
      openDialog("rewind")

      return
    }

    const parsed = Number.parseInt(trimmed, 10)

    if (!Number.isFinite(parsed) || parsed < 1) {
      showToast({ variant: "error", title: language.t("dialog.rewind.toast.invalid") })

      return
    }

    const { executeRewindSteps } = await import("@/session/commands/session-control-dialogs")
    await executeRewindSteps({ sessionID, steps: parsed, sdk: serverSDK, data, language })
  }

  const setContextLimit = async (input?: string) => {
    const trimmed = input?.trim()

    if (!trimmed) {
      openDialog("context-limit")

      return
    }

    const { applyModelContextLimit, parseTokenCount } = await import("@/session/commands/session-control-dialogs")
    const parts = trimmed.split(/\s+/)
    const active = actions.model()
    const activeKey = active ? `${active.providerID}/${active.id}` : undefined

    if (parts.length === 1) {
      const parsed = parseTokenCount(parts[0] ?? "")

      if (!parsed) {
        showToast({ variant: "error", title: language.t("dialog.contextLimit.toast.invalid") })

        return
      }

      if (!activeKey) {
        showToast({ variant: "error", title: language.t("dialog.contextLimit.toast.noModel") })

        return
      }

      await applyModelContextLimit({
        modelKey: activeKey,
        limit: parsed,
        sessionID: actions.session.identity.params.id,
        sdk: serverSDK,
        data,
        language,
      })

      return
    }

    const targetModel = parts[0] ?? ""
    const parsed = parseTokenCount(parts[1] ?? "")

    if (!targetModel || !parsed) {
      showToast({ variant: "error", title: language.t("dialog.contextLimit.toast.invalid") })

      return
    }

    await applyModelContextLimit({
      modelKey: targetModel,
      limit: parsed,
      sessionID: actions.session.identity.params.id,
      sdk: serverSDK,
      data,
      language,
    })
  }

  const copyLastMessage = async () => {
    const sessionID = actions.session.identity.params.id

    if (!sessionID) return
    const allMessages = data.session.message.list(sessionID) ?? []
    const revertID = data.session.get(sessionID)?.revert?.messageID

    const messages = revertID
      ? allMessages.slice(
          0,
          Math.max(
            0,
            allMessages.findIndex((m) => m.id === revertID),
          ),
        )
      : allMessages

    const lastAssistant = messages.findLast(
      (msg) =>
        msg.type === "assistant" ||
        (msg.type === "compaction" && msg.status === "completed" && msg.summary.trim() !== ""),
    )

    if (!lastAssistant) {
      showToast({ variant: "error", title: language.t("toast.copyLastMessage.empty") })

      return
    }

    const text =
      lastAssistant.type === "assistant"
        ? lastAssistant.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim()
        : lastAssistant.type === "compaction" && lastAssistant.status === "completed"
          ? lastAssistant.summary.trim()
          : ""

    if (!text) {
      showToast({ variant: "error", title: language.t("toast.copyLastMessage.empty") })

      return
    }

    try {
      await (platform.writeClipboardText?.(text) ?? navigator.clipboard.writeText(text))
      showToast({ variant: "success", title: language.t("toast.copyLastMessage.copied") })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  const changeDirectory = async (input?: string) => {
    const sessionID = actions.session.identity.params.id

    if (!sessionID) return
    const trimmed = input?.trim()

    if (!trimmed) {
      openDialog("cd")

      return
    }

    try {
      await serverSDK.api.session.move({ sessionID, directory: trimmed })
      showToast({
        variant: "success",
        title: language.t("dialog.cd.toast.moved", { directory: trimmed }),
      })
    } catch (cause: unknown) {
      showToast({
        variant: "error",
        title: formatServerError(cause, language.t, language.t("common.requestFailed")),
      })
    }
  }

  const renameSession = async (input?: string) => {
    const sessionID = actions.session.identity.params.id

    if (!sessionID) return
    const trimmed = input?.trim()

    if (!trimmed) {
      openDialog("rename")

      return
    }

    try {
      await serverSDK.api.session.update({ sessionID, title: trimmed })
      showToast({
        variant: "success",
        title: language.t("dialog.renameSession.toast.updated"),
      })
    } catch (cause: unknown) {
      showToast({
        variant: "error",
        title: formatServerError(cause, language.t, language.t("common.requestFailed")),
      })
    }
  }

  const deleteSession = () => {
    if (actions.session.identity.params.id) openDialog("delete")
  }

  const switchSession = () => openDialog("sessions")

  const reviewPlan = () => {
    const sessionID = actions.session.identity.params.id
    const objectives = actions.session.data.objectives()

    if (!sessionID || !objectives) {
      showToast({
        title: language.t("dialog.planApproval.toast.noPlan"),
      })

      return
    }

    openDialog("plan")
  }

  const unapprovePlan = () => {
    const sessionID = actions.session.identity.params.id
    const objectives = actions.session.data.objectives()

    if (!sessionID || !objectives) {
      showToast({
        title: language.t("dialog.planApproval.toast.noPlan"),
      })

      return
    }

    void serverSDK.api.session
      .prompt({
        sessionID,
        text: "invalidar aprobacion",
        metadata: { planRevocation: true },
      })
      .then(
        () => {
          showToast({
            title: language.t("dialog.planApproval.toast.revoked"),
          })
        },
        (cause: unknown) => {
          showToast({
            variant: "error",
            title: formatServerError(cause, language.t, language.t("common.requestFailed")),
          })
        },
      )
  }
  // Every change to what the list below reads rebuilds all commands, registers every keybind again and re-renders the
  // controls that show one. The transcript changes with each message, tool update and history page, so the list reads
  // it only through values that change when a command does.
  const hasMessages = createMemo(() => actions.session.history.visibleUserMessages().length > 0)
  const canUndo = createMemo(actions.revert.canUndo)
  const canRedo = createMemo(actions.revert.canRedo)
  const blocking = createMemo(actions.background.blocking)

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      slash: "new",
      onSelect: (source) => command.trigger("tab.new", source),
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !canUndo(),
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !canRedo(),
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.rewind",
      title: language.t("command.session.rewind"),
      description: language.t("command.session.rewind.description"),
      slash: "rewind",
      slashAliases: ["undo-steps", "undosteps", "retry-steps"],
      slashArguments: true,
      disabled: !actions.session.identity.params.id || actions.session.history.visibleUserMessages().length === 0,
      onSelect: (_source, input) => void rewindSteps(input),
    }),
    sessionCommand({
      id: "session.context.limit",
      title: language.t("command.session.setContextLimit"),
      description: language.t("command.session.setContextLimit.description"),
      slash: "setContextLimit",
      slashAliases: ["setcontextlimit"],
      slashArguments: true,
      onSelect: (_source, input) => void setContextLimit(input),
    }),
    sessionCommand({
      id: "messages.copy",
      title: language.t("command.session.copyLastMessage"),
      description: language.t("command.session.copyLastMessage.description"),
      slash: "copy",
      disabled: !actions.session.identity.params.id,
      onSelect: () => void copyLastMessage(),
    }),
    sessionCommand({
      id: "session.cd",
      title: language.t("command.session.cd"),
      description: language.t("command.session.cd.description"),
      slash: "cd",
      slashArguments: true,
      disabled: !actions.session.identity.params.id,
      onSelect: (_source, input) => void changeDirectory(input),
    }),
    sessionCommand({
      id: "session.rename",
      title: language.t("command.session.rename"),
      description: language.t("command.session.rename.description"),
      slash: "rename",
      slashArguments: true,
      disabled: !actions.session.identity.params.id,
      onSelect: (_source, input) => void renameSession(input),
    }),
    sessionCommand({
      id: "session.delete",
      title: language.t("command.session.delete"),
      description: language.t("command.session.delete.description"),
      slash: "delete",
      slashAliases: ["session.delete"],
      disabled: !actions.session.identity.params.id,
      onSelect: deleteSession,
    }),
    sessionCommand({
      id: "session.switch",
      title: language.t("command.session.switch"),
      description: language.t("command.session.switch.description"),
      slash: "sessions",
      slashAliases: ["resume", "continue"],
      onSelect: switchSession,
    }),
    sessionCommand({
      id: "session.plan.review",
      title: language.t("command.session.plan"),
      description: language.t("command.session.plan.description"),
      slash: "plan",
      disabled: !actions.session.identity.params.id || !actions.session.data.objectives(),
      onSelect: reviewPlan,
    }),
    sessionCommand({
      id: "session.plan.unapprove",
      title: language.t("command.session.unapprove"),
      description: language.t("command.session.unapprove.description"),
      slash: "unapprove",
      disabled:
        !actions.session.identity.params.id ||
        (!actions.session.data.objectives()?.approvedByUser &&
          actions.session.data.objectives()?.status !== "exploring"),
      onSelect: unapprovePlan,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !actions.session.identity.params.id || !hasMessages(),
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.background",
      title: language.t("command.session.background"),
      keybind: "ctrl+b",
      disabled: !blocking(),
      onSelect: actions.background.move,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !actions.session.identity.params.id || !hasMessages(),
      onSelect: fork,
    }),
    sessionCommand({
      id: "session.export",
      title: language.t("command.session.export"),
      description: language.t("command.session.export.description"),
      slash: "export",
      disabled:
        !actions.session.identity.params.id ||
        exporter.exporting({ server: server.key, sessionID: actions.session.identity.params.id }),
      onSelect: exportSession,
    }),
    sessionCommand({
      id: "session.copyID",
      title: language.t("command.session.copyID"),
      disabled: !actions.session.identity.params.id,
      onSelect: copySessionID,
    }),
    sessionCommand({
      id: "session.archive",
      title: language.t("command.session.archive"),
      keybind: "mod+shift+s",
      // Toggles, so one shortcut archives a session and brings an archived one back.
      disabled: !archivable() && !unarchivable(),
      onSelect: () => (unarchivable() ? unarchiveSession() : archiveSession()),
    }),
    sessionCommand({
      id: "session.unarchive",
      title: language.t("command.session.unarchive"),
      disabled: !unarchivable(),
      onSelect: unarchiveSession,
    }),
  ]

  const fileCmds = () => {
    const tab = closableTab()
    const cycle = cycleSideTabs()
    const side = actions.session.layout.view().side.opened()

    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+p",
        slash: "open",
        slashAliases: ["projects", "project"],
        onSelect: openFile,
      }),
      fileCommand({
        id: "file.close",
        title: language.t("command.tab.close"),
        keybind: "mod+w",
        follows: "tab.close",
        hidden: !tab,
        // While the side region is open, ⌘W closes its tabs wherever focus is.
        when: (event) => (side ? !pluginClaims(event) : selectCloseTabSwallowed(closeGuard())),
        onSelect: (source) => {
          if (!side) return
          closeTab()
          dispatchCloseGuard({
            type: "close.completed",
            keybind: source === "keybind",
            tabKey: actions.session.layout.tabKey(),
            sideOpened: actions.session.layout.view().side.opened(),
          })
        },
      }),
      side &&
        fileCommand({
          id: "file.tab.new",
          title: "",
          keybind: settings.keybinds.get("tab.new") ?? "mod+t",
          hidden: true,
          when: sideKey,
          onSelect: openSideTab,
        }),
      fileCommand({
        id: "file.tab.reopen",
        title: "",
        keybind: settings.keybinds.get("tab.reopenClosed") ?? "mod+shift+t",
        hidden: true,
        when: (event) => reopensSideTab() && !pluginClaims(event),
        onSelect: () => actions.region.reopen(),
      }),
      cycle &&
        fileCommand({
          id: "file.tab.prev",
          title: "",
          keybind: settings.keybinds.get("tab.prev") ?? "mod+option+ArrowLeft,ctrl+shift+tab",
          hidden: true,
          when: (event) => sideFocused(event.target),
          onSelect: () => selectAdjacentSideTab(-1),
        }),
      cycle &&
        fileCommand({
          id: "file.tab.next",
          title: "",
          keybind: settings.keybinds.get("tab.next") ?? "mod+option+ArrowRight,ctrl+tab",
          hidden: true,
          when: (event) => sideFocused(event.target),
          onSelect: () => selectAdjacentSideTab(1),
        }),
      ...(actions.session.layout.view().side.opened()
        ? sideTabShortcuts({
            keys: actions.region.keys,
            active: actions.region.active,
            select: selectSideTab,
            when: inSide,
          }).map(fileCommand)
        : []),
    ].filter((v) => !!v)
  }

  const projectCmds = () => [
    projectCommand({
      id: "project.copyID",
      title: language.t("command.project.copyID"),
      disabled: !actions.session.data.info()?.projectID,
      onSelect: copyProjectID,
    }),
  ]

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: actions.region.toggle,
    }),
    ...(actions.region.pane("bottom").keys().length > 0
      ? [
          viewCommand({
            id: "bottom.toggle",
            title: language.t("command.bottom.toggle"),
            keybind: "mod+j",
            onSelect: () => {
              const bottom = actions.session.layout.view().bottom
              bottom.setOpened(!bottom.opened())
            },
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "session.jumpToMessage",
      title: language.t("dialog.jump.title"),
      description: language.t("command.session.jumpToMessage.description"),
      keybind: "mod+alt+g",
      slash: "timeline",
      disabled: !actions.session.identity.params.id,
      onSelect: () => openDialog("jump"),
    }),
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !actions.session.identity.params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !actions.session.identity.params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      slashAliases: ["mcps"],
      onSelect: chooseMcp,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: autoAccepting()
        ? language.t("command.permissions.autoaccept.disable")
        : autoApprove.scoped()
          ? language.t("command.permissions.autoaccept.project")
          : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      slash: "yolo",
      slashAliases: ["autoapprove", "auto-approve", "no-approval", "noapproval", "permissions"],
      keywords: "yolo autoapprove auto-approve no-approval permissions",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...projectCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}
