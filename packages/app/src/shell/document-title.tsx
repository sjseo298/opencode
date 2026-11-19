import { Title } from "@solidjs/meta"
import {
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { usePlatform } from "@/runtime/platform/platform"
import { formatBrowserDocumentTitle, ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"

type DocumentTitleEntry = {
  readonly id: string
  readonly title?: () => string | undefined
  readonly machine?: () => string | undefined
}

type DocumentTitleContextValue = {
  register: (entry: DocumentTitleEntry) => void
  unregister: (id: string) => void
}

const DocumentTitleContext = createContext<DocumentTitleContextValue>()

export function DocumentTitleHost(props: ParentProps<{ defaultMachine: () => string | undefined }>) {
  const [entries, setEntries] = createSignal<readonly DocumentTitleEntry[]>([])

  const text = createMemo(() => {
    const active = entries().at(-1)

    if (!active) return formatBrowserDocumentTitle({ machine: props.defaultMachine() })

    return formatBrowserDocumentTitle({
      sessionTitle: active.title?.(),
      machine: active.machine ? active.machine() : props.defaultMachine(),
    })
  })

  const value: DocumentTitleContextValue = {
    register(entry) {
      setEntries((prev) => [...prev, entry])
    },
    unregister(id) {
      setEntries((prev) => prev.filter((item) => item.id !== id))
    },
  }

  // Keep a single <Title> mounted across all routes so @solidjs/meta's removeTag never re-inserts the base
  // "OpenCode" <title> element at the top of <head> when transitioning between sessions, drafts, and home.
  return (
    <DocumentTitleContext.Provider value={value}>
      <Title>{text()}</Title>
      {props.children}
    </DocumentTitleContext.Provider>
  )
}

export function DocumentTitleProvider(props: ParentProps) {
  const platform = usePlatform()
  const servers = useServers()
  const global = useGlobal()

  const defaultMachine = createMemo(() => {
    if (platform.platform !== "web") return undefined
    const conn = servers.list.find(servers.current) ?? servers.list[0]

    if (!conn) return undefined
    const key = ServerConnection.key(conn)
    const worktrees = global.serverCtx(key)?.projects.list().map((p) => p.worktree)

    return servers.machineBadge(conn, worktrees)
  })

  return <DocumentTitleHost defaultMachine={defaultMachine}>{props.children}</DocumentTitleHost>
}

export function useDocumentTitle(input: {
  title?: () => string | undefined
  machine?: () => string | undefined
}) {
  const ctx = useContext(DocumentTitleContext)

  if (!ctx) return

  const id = createUniqueId()

  ctx.register({ id, title: input.title, machine: input.machine })
  onCleanup(() => ctx.unregister(id))
}
