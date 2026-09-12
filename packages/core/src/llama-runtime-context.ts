export * as LlamaRuntimeContext from "./llama-runtime-context"

type ResolveInput = {
  readonly baseURL: string
  readonly providerID?: string
  readonly modelIDs?: readonly string[]
  readonly timeoutMs?: number
  readonly ttlMs?: number
  readonly fetch?: Fetch
}

export type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

type CacheValue =
  | {
      readonly kind: "context"
      readonly context: number
    }
  | {
      readonly kind: "models"
      readonly modelAlias?: string
      readonly models: readonly Record<string, unknown>[]
    }

const DEFAULT_TIMEOUT_MS = 1_200
const DEFAULT_TTL_MS = 60_000
const NEGATIVE_TTL_MS = 5_000

const cache = new Map<
  string,
  {
    value: CacheValue | undefined
    expiresAt: number
    pending?: Promise<CacheValue | undefined>
  }
>()

export function clearCache() {
  cache.clear()
}

export function shouldResolve(input: { readonly baseURL: string; readonly providerID?: string }) {
  const parsed = parseBaseURL(input.baseURL)
  if (!parsed) return false
  return shouldResolveParsed(parsed, input.providerID)
}

export async function resolve(input: ResolveInput): Promise<number | undefined> {
  const parsed = parseBaseURL(input.baseURL)
  if (!parsed) return
  if (!shouldResolveParsed(parsed, input.providerID)) return

  const key = cacheKey(parsed)
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.pending === undefined && cached.expiresAt > now) {
    return contextForInput(cached.value, input.modelIDs)
  }
  if (cached?.pending) {
    return cached.pending.then((value) => contextForInput(value, input.modelIDs))
  }

  const pending = resolveUncached(parsed, input)
    .then((value) => {
      const ttl = value === undefined ? Math.min(ttlMs, NEGATIVE_TTL_MS) : ttlMs
      cache.set(key, { value, expiresAt: Date.now() + ttl })
      return value
    })
    .catch(() => {
      cache.set(key, { value: undefined, expiresAt: Date.now() + Math.min(ttlMs, NEGATIVE_TTL_MS) })
      return undefined
    })

  cache.set(key, { value: cached?.value, expiresAt: cached?.expiresAt ?? 0, pending })
  return pending.then((value) => contextForInput(value, input.modelIDs))
}

function contextForInput(value: CacheValue | undefined, modelIDs: readonly string[] | undefined) {
  if (!value) return
  if (value.kind === "context") return value.context
  const ids = value.modelAlias ? [...(modelIDs ?? []), value.modelAlias] : [...(modelIDs ?? [])]
  return modelsContextFromRecords(value.models, ids)
}

function parseBaseURL(value: string) {
  if (value.includes("${")) return
  if (!URL.canParse(value)) return
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
  return parsed
}

function shouldResolveParsed(parsed: URL, providerID: string | undefined) {
  const id = providerID?.toLowerCase() ?? ""
  if (id.includes("llama")) return true
  return isLikelyLocalHost(parsed.hostname)
}

function isLikelyLocalHost(hostname: string) {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "::1") return true
  if (host.endsWith(".local")) return true
  if (host.startsWith("127.")) return true
  if (host.startsWith("10.")) return true
  if (host.startsWith("192.168.")) return true
  if (host.startsWith("169.254.")) return true
  if (!host.startsWith("172.")) return false
  const octet = Number(host.split(".")[1])
  if (!Number.isInteger(octet)) return false
  return octet >= 16 && octet <= 31
}

function cacheKey(base: URL) {
  return `${base.origin}${normalizePath(base.pathname)}`
}

function normalizePath(pathname: string) {
  if (pathname === "/") return pathname
  const normalized = pathname.replace(/\/+$/g, "")
  if (normalized === "") return "/"
  return normalized
}

function pathJoin(base: string, suffix: string) {
  const root = normalizePath(base)
  const leaf = suffix.replace(/^\/+/, "")
  if (root === "/") return `/${leaf}`
  return `${root}/${leaf}`
}

function pathURL(base: URL, pathname: string) {
  const resolved = new URL(base.origin)
  resolved.pathname = pathname
  return resolved.toString()
}

function propsURLs(base: URL) {
  const path = normalizePath(base.pathname)
  const root = path.endsWith("/v1") ? path.slice(0, -3) || "/" : undefined
  const paths = new Set<string>()
  if (root) paths.add(pathJoin(root, "props"))
  paths.add("/props")
  if (path !== "/") paths.add(pathJoin(path, "props"))
  return Array.from(paths, (item) => pathURL(base, item))
}

function modelsURLs(base: URL) {
  const path = normalizePath(base.pathname)
  const paths = new Set<string>()
  if (path.endsWith("/v1")) paths.add(pathJoin(path, "models"))
  if (path !== "/") {
    paths.add(pathJoin(path, "models"))
    if (!path.endsWith("/v1")) paths.add(pathJoin(path, "v1/models"))
  }
  paths.add("/v1/models")
  return Array.from(paths, (item) => pathURL(base, item))
}

function slotsURLs(base: URL) {
  const path = normalizePath(base.pathname)
  const root = path.endsWith("/v1") ? path.slice(0, -3) || "/" : undefined
  const paths = new Set<string>()
  if (root) paths.add(pathJoin(root, "slots"))
  paths.add("/slots")
  if (path !== "/") {
    paths.add(pathJoin(path, "slots"))
    if (!path.endsWith("/v1")) paths.add(pathJoin(path, "v1/slots"))
  }
  return Array.from(paths, (item) => pathURL(base, item))
}

async function resolveUncached(base: URL, input: ResolveInput) {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = input.fetch ?? fetch
  const props = await fetchFirstJSON(propsURLs(base), fetchFn, timeoutMs)
  const context = propsContext(props)
  if (context !== undefined) return { kind: "context" as const, context }

  const slots = await fetchFirstJSON(slotsURLs(base), fetchFn, timeoutMs)
  const slotContext = slotsContext(slots)
  if (slotContext !== undefined) return { kind: "context" as const, context: slotContext }

  const models = await fetchFirstJSON(modelsURLs(base), fetchFn, timeoutMs)
  const records = modelRecords(models)
  if (records.length === 0) return
  return {
    kind: "models" as const,
    modelAlias: propsModelAlias(props),
    models: records,
  }
}

async function fetchFirstJSON(urls: readonly string[], fetchFn: Fetch, timeoutMs: number) {
  for (const url of urls) {
    const payload = await fetchJSON(url, fetchFn, timeoutMs)
    if (payload !== undefined) return payload
  }
}

async function fetchJSON(url: string, fetchFn: Fetch, timeoutMs: number) {
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
  if (!response || !response.ok) return
  return response.json().catch(() => undefined)
}

function propsContext(payload: unknown) {
  const root = asRecord(payload)
  if (!root) return
  const topLevel = [
    positiveInteger(root.n_ctx),
    positiveInteger(root.context_length),
    contextFromText(root.ctx),
    contextFromText(root.context),
  ].flatMap((value) => (value === undefined ? [] : [value]))
  if (topLevel.length > 0) return Math.max(...topLevel)
  const settings = asRecord(root.default_generation_settings)
  if (!settings) return
  const direct = positiveInteger(settings.n_ctx)
  if (direct !== undefined) return direct
  const params = asRecord(settings.params)
  if (!params) return
  return positiveInteger(params.n_ctx)
}

function propsModelAlias(payload: unknown) {
  const root = asRecord(payload)
  if (!root) return
  const alias = text(root.model_alias)
  if (alias) return alias
  return text(root.model_path)
}

function modelsContext(payload: unknown, modelIDs: readonly string[]) {
  return modelsContextFromRecords(modelRecords(payload), modelIDs)
}

function modelsContextFromRecords(models: readonly Record<string, unknown>[], modelIDs: readonly string[]) {
  if (models.length === 0) return
  const matched = matchedModel(models, modelIDs)
  if (matched) return modelContext(matched)
  if (models.length === 1) return modelContext(models[0])
}

function slotsContext(payload: unknown) {
  const contexts = slotRecords(payload).flatMap(slotContext)
  if (contexts.length === 0) return
  return Math.max(...contexts)
}

function slotRecords(payload: unknown) {
  if (Array.isArray(payload)) return payload.flatMap((item) => (asRecord(item) ? [item] : []))
  const root = asRecord(payload)
  if (!root) return []
  const numericKeyed = Object.entries(root).flatMap(([key, item]) => {
    if (!/^\d+$/.test(key)) return []
    const record = asRecord(item)
    if (!record) return []
    return [record]
  })
  if (numericKeyed.length > 0) return numericKeyed
  const nested = [root.slots, root.data, root.items].flatMap((list) => {
    if (!Array.isArray(list)) return []
    return list.flatMap((item) => (asRecord(item) ? [item] : []))
  })
  if (nested.length > 0) return nested
  return [root]
}

function slotContext(slot: Record<string, unknown>) {
  const own = [slot, asRecord(slot.params), asRecord(slot.slot), asRecord(slot.state)].flatMap(slotContextRecord)
  return own
}

function slotContextRecord(record: Record<string, unknown> | undefined) {
  if (!record) return []
  const numeric = [
    positiveInteger(record.n_ctx),
    positiveInteger(record.n_ctx_slot),
    positiveInteger(record.context_length),
    positiveInteger(record.context_size),
    positiveInteger(record.ctx_size),
  ].flatMap((value) => (value === undefined ? [] : [value]))
  const text = Object.entries(record).flatMap(([key, value]) => {
    if (typeof value !== "string") return []
    const normalized = key.toLowerCase()
    if (!normalized.includes("ctx") && !normalized.includes("context") && !normalized.includes("tok")) return []
    const parsed = contextFromText(value)
    if (parsed === undefined) return []
    return [parsed]
  })
  return [...numeric, ...text]
}

function contextFromText(value: unknown) {
  if (typeof value !== "string") return
  const usedTotal = value.match(/\b\d+\s*\/\s*(\d+)\s*tok(?:en)?s?/i)
  if (usedTotal) return positiveInteger(usedTotal[1])
  const labeled = value.match(/(?:n[_\s-]*ctx(?:[_\s-]*slot)?|context(?:[_\s-]*(?:length|size))?|ctx(?:[_\s-]*size)?)\s*[:=]\s*(\d+)/i)
  if (labeled) return positiveInteger(labeled[1])
}

function modelRecords(payload: unknown) {
  if (Array.isArray(payload)) return payload.flatMap((item) => (asRecord(item) ? [item] : []))
  const root = asRecord(payload)
  if (!root) return []
  if (!Array.isArray(root.data)) return []
  return root.data.flatMap((item) => (asRecord(item) ? [item] : []))
}

function matchedModel(models: readonly Record<string, unknown>[], modelIDs: readonly string[]) {
  const targets = Array.from(new Set(modelIDs.map(normalizeModelID).filter((item): item is string => Boolean(item))))
  if (targets.length === 0) return
  for (const model of models) {
    if (targets.some((target) => modelMatches(model, target))) return model
  }
}

function modelMatches(model: Record<string, unknown>, target: string) {
  const values = [
    text(model.id),
    ...stringList(model.aliases),
  ]
  return values.some((value) => normalizedMatch(value, target))
}

function normalizedMatch(value: string | undefined, target: string) {
  const candidate = normalizeModelID(value)
  if (!candidate) return false
  if (candidate === target) return true
  if (target.length >= 10 && candidate.includes(target)) return true
  if (candidate.length >= 10 && target.includes(candidate)) return true
  return false
}

function normalizeModelID(value: string | undefined) {
  if (!value) return
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "")
  if (normalized === "") return
  return normalized
}

function modelContext(model: Record<string, unknown>) {
  const limit = asRecord(model.limit)
  const fromLimit = positiveInteger(limit?.context)
  if (fromLimit !== undefined) return fromLimit
  const fromContextLength = positiveInteger(model.context_length)
  if (fromContextLength !== undefined) return fromContextLength
  const fromMaxContext = positiveInteger(model.max_context_length)
  if (fromMaxContext !== undefined) return fromMaxContext
  const fromInputLimit = positiveInteger(model.input_token_limit)
  if (fromInputLimit !== undefined) return fromInputLimit
  const meta = asRecord(model.meta)
  if (!meta) return
  const metaContext = positiveInteger(meta.n_ctx)
  if (metaContext !== undefined) return metaContext
  const metaContextLength = positiveInteger(meta.context_length)
  if (metaContextLength !== undefined) return metaContextLength
  return positiveInteger(meta.n_ctx_train)
}

function positiveInteger(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number") return
  if (!Number.isFinite(number)) return
  if (number <= 0) return
  return Math.floor(number)
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === "string" ? [item] : []))
}

function text(value: unknown) {
  if (typeof value !== "string") return
  if (value.trim() === "") return
  return value
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
