import { For } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog, type DialogSize } from "./dialog"
import { RGBA, TextAttributes } from "@opentui/core"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
  size?: DialogSize
}

type FormattedToken = {
  text: string
  fg?: RGBA
  attributes?: number
}

function parseFormattedMessage(input: string, theme: ReturnType<ReturnType<typeof useTheme>["surface"]>): FormattedToken[] {
  const regex = /\x1b\[([0-9;]+)m/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  const tokens: FormattedToken[] = []
  let currentFg: RGBA | undefined
  let currentAttrs = TextAttributes.NONE

  while ((match = regex.exec(input)) !== null) {
    const textPart = input.slice(lastIndex, match.index)
    if (textPart) {
      tokens.push({ text: textPart, fg: currentFg, attributes: currentAttrs || undefined })
    }
    const codes = match[1].split(";").map(Number)
    for (const code of codes) {
      if (code === 0) {
        currentFg = undefined
        currentAttrs = TextAttributes.NONE
      } else if (code === 1) {
        currentAttrs |= TextAttributes.BOLD
      } else if (code === 2) {
        currentAttrs |= TextAttributes.DIM
      } else if (code === 31) {
        currentFg = theme.text.feedback.error.base
      } else if (code === 32) {
        currentFg = theme.text.feedback.success.base
      } else if (code === 33) {
        currentFg = theme.text.feedback.warning.base
      } else if (code === 36) {
        currentFg = theme.text.feedback.info.base
      }
    }
    lastIndex = regex.lastIndex
  }
  const remaining = input.slice(lastIndex)
  if (remaining) {
    tokens.push({ text: remaining, fg: currentFg, attributes: currentAttrs || undefined })
  }
  return tokens
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")

  if (props.size) {
    dialog.setSize(props.size)
  }

  const confirm = () => {
    props.onConfirm?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm alert",
        group: "Dialog",
        run: confirm,
      },
    ],
  }))

  const tokens = () => parseFormattedMessage(props.message, theme)

  return (
    <DialogLayout
      header={<DialogHeader title={props.title} />}
      footer={{ actions: { primary: [{ title: "ok", key: "enter", onTrigger: confirm }] } }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.background.action.primary.focused}
            onMouseUp={confirm}
          >
            <text fg={theme.text.action.primary.focused}>ok</text>
          </box>
        </box>
      }
    >
      <text fg={theme.text.muted}>
        <For each={tokens()}>
          {(token) => (
            <span
              style={{
                fg: token.fg ?? (token.attributes && token.attributes & TextAttributes.DIM ? theme.text.faint : theme.text.muted),
                attributes: token.attributes,
              }}
            >
              {token.text}
            </span>
          )}
        </For>
      </text>
    </DialogLayout>
  )
}
