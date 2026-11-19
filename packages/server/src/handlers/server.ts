import { readdirSync } from "node:fs"
import { hostname } from "node:os"
import { Duration, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { ServerInfo } from "../server-info"
import { ServerPairing } from "../pairing"

const DOCKER_HEX_HOSTNAME = /^[0-9a-f]{12,64}$/i

export function resolveServerHostname(input?: {
  readonly rawHostname?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly listWorkspaces?: () => ReadonlyArray<string>
}) {
  const env = input?.env ?? process.env
  const explicit = (env.OPENCODE_SERVER_NAME ?? env.OPENCODE_MACHINE_NAME ?? "").trim()
  if (explicit) return explicit

  const raw = (input?.rawHostname ?? hostname() ?? "").trim()
  if (DOCKER_HEX_HOSTNAME.test(raw)) {
    const readWorkspaces =
      input?.listWorkspaces ??
      (() => {
        try {
          return readdirSync("/workspaces")
        } catch {
          return []
        }
      })
    const folders = readWorkspaces().filter((name) => name && !name.startsWith("."))
    if (folders.length === 1) return folders[0]
  }

  return raw || undefined
}

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const pairing = yield* ServerPairing.Service
    const auth = yield* ServerAuth.Config

    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return {
            version: info.app.version ?? "unknown",
            pid: process.pid ?? 0,
            hostname: resolveServerHostname(),
            urls: info.urls(),
            paths: info.paths,
            capabilities: { persistentPty: PersistentPty.available },
          }
        }),
      )
      .handle("server.pair", () => pairing.issue())
      .handle(
        "server.connect",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browser navigations ask for HTML; everything else is an API client that wants the token.
          const browser = request.headers.accept?.includes("text/html") === true
          const token = (yield* pairing.consume(ctx.params.code)) ? ServerAuth.issueSession(auth) : undefined
          if (token === undefined) {
            if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
            return HttpServerResponse.text(
              "This pairing link expired or was already used. Run `opencode pair` to get a new one.",
              { status: 401 },
            )
          }
          if (!browser) return { token }
          return HttpServerResponse.redirect("/").pipe(
            HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
              path: "/",
              httpOnly: true,
              sameSite: "lax",
              maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
            }),
          )
        }),
      )
  }),
)
