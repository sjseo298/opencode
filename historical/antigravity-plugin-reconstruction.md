# Documento Histórico: Arquitectura y Reconstrucción Paso a Paso del Plugin Antigravity (`opencode-antigravity-auth`)

> **Commit de referencia previo al retiro:** `3dc7393611bdf573c2e0174a56272ea673a20d7e`
> **Propósito:** Documentar con precisión archivo por archivo cómo estaba integrado el plugin **Google Antigravity** (`id: "opencode-antigravity-auth"`) en OpenCode v2 antes de su retiro, y proveer las instrucciones exactas para reconstruirlo o restaurarlo en el futuro.

---

## 1. Visión General y Desambiguación

El plugin **Antigravity** (`opencode-antigravity-auth`) permitía a OpenCode consumir modelos servidos por **Google Cloud Code Assist / Antigravity Hub** (variantes Gemini y Claude con pensamiento extendido) usando **OAuth 2.0 + PKCE** con rotación multi-cuenta, consulta de cuotas, herramienta `google_search` y paridad de interfaz en **TUI** y **Web/Desktop**.

### Qué NO forma parte de este plugin (Upstream OpenCode)
El repositorio mantiene el soporte upstream para abrir archivos en la aplicación externa **Antigravity IDE** ("Open in Antigravity"):
- `packages/gui-plugins/src/file/apps.ts` (`"antigravity"` en `OPEN_APPS`)
- `packages/gui-plugins/src/file/open-in-app.tsx` y `packages/gui-plugins/src/file/i18n/*.ts`
- `packages/ui/src/assets/icons/app/antigravity.svg`, `packages/ui/src/components/app-icon.tsx`, `packages/ui/src/components/app-icons/types.ts`
- Documentación histórica del ecosistema v1 en `services/site/src/docs/v1/content/**/ecosystem.mdx`

---

## 2. Mapa Completo de Archivos (Antes del Retiro)

### 2.1 `@opencode/schema` (Contratos compartidos y paridad)
| Archivo | Rol |
| :--- | :--- |
| `packages/schema/src/antigravity.ts` | Esquemas Effect (`QuotaSummarySchema`, `AccountSummarySchema`, `AntigravitySettingsSchema`, `AntigravitySettingsUpdateSchema`, `QuotaAccountReportSchema`), `DEFAULT_ANTIGRAVITY_SETTINGS`, contrato `AntigravityAccountsRpc` (`id: "antigravity.accounts"`, métodos `list`, `connections`, `quotas`, `update`, `models`, `getConfig`, `updateConfig`), helpers `formatQuotaSummary` y `stripAnsiCodes`. |
| `packages/schema/src/surface-parity.ts` | Entrada `{ id: "antigravity.accounts", names: ["antigravity", "ag"], surfaces: ["tui", "web"] }` en `SLASH_COMMAND_PARITY` y las 5 entradas `antigravity.*` en `SHARED_SERVER_SETTINGS`. |
| `packages/schema/test/surface-parity.test.ts` | Test unitario de `AntigravityAccountsRpc`, `DEFAULT_ANTIGRAVITY_SETTINGS`, `formatQuotaSummary` y `stripAnsiCodes`. |
| `packages/schema/test/contract-hygiene.test.ts` | Verificación de identificadores únicos para los 5 esquemas de `Antigravity`. |
| `script/check-surface-parity.ts` | Validación automática de que todos los campos de `AntigravitySettingsSchema` existen en `SHARED_SERVER_SETTINGS`, en TUI (`dialog-config.tsx`) y en Web (`AntigravitySettingsSection` en `general.tsx`). |

### 2.2 `@opencode/core` (Backend y motor del plugin)
| Archivo / Directorio | Rol |
| :--- | :--- |
| `packages/core/src/plugin/builtin/index.ts` | Re-exporta `export * as AntigravityPlugin from "./antigravity/index.js"`. |
| `packages/core/src/plugin/internal.ts` | Importa `AntigravityPlugin`, registra `fromPromise(AntigravityPlugin.Plugin)` en `pre` (antes de `...ProviderPlugins`) y añade `AntigravityPlugin.Plugin.id` al `Set` `guarded`. |
| `packages/core/package.json` | Dependencias `proper-lockfile` (`4.1.2`) y `@types/proper-lockfile` (`4.1.4`) usadas exclusivamente por `antigravity/plugin/storage.ts`, además de `zod` usado en el árbol del plugin. |
| `packages/core/src/plugin/builtin/antigravity/index.ts` | Re-exporta `./v2.js` y `AntigravityV2Plugin as Plugin`. |
| `packages/core/src/plugin/builtin/antigravity/v2.ts` | Adaptador OpenCode v2 (`Plugin.define({ id: "opencode-antigravity-auth" })`). Ver sección 3. |
| `packages/core/src/plugin/builtin/antigravity/plugin.ts` | Motor legado `createAntigravityPlugin(providerId)` (gestión de cuentas, rotación, reintentos de capacidad, intercepción `fetch`). |
| `packages/core/src/plugin/builtin/antigravity/constants.ts` | Endpoints (`ANTIGRAVITY_ENDPOINT_DAILY`, `ANTIGRAVITY_ENDPOINT_PROD`), `ANTIGRAVITY_SCOPES`, y `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` codificados con `String.fromCharCode(...)` para evitar falsos positivos de GitHub Secret Scanning. |
| `packages/core/src/plugin/builtin/antigravity/antigravity/oauth.ts` | Flujo PKCE nativo (`node:crypto`), `authorizeAntigravity`, `exchangeAntigravity`. |
| `packages/core/src/plugin/builtin/antigravity/tui.ts` | Copia histórica del plugin TUI embebida en el paquete core (reemplazada en runtime por `packages/tui/src/feature-plugins/antigravity/`). |
| `packages/core/src/plugin/builtin/antigravity/shims.d.ts` | Declaraciones globales mínimas (`RequestInfo`, `HeadersInit`, `BodyInit`). |
| `packages/core/src/plugin/builtin/antigravity/HOMOLOGATION.md` | Guía rápida de homologación con el binario oficial `agy`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/account-management.ts` | Handlers RPC de `AntigravityAccountsRpc` (`registerAccountManagement`), lectura/escritura de cuentas y `antigravity.json`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/account-rpc.ts` | Re-exporta tipos y `AntigravityAccountsRpc` desde `@opencode/schema/antigravity`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/accounts.ts` | `AccountManager`, selección híbrida, parsing de rate limits (`parseRateLimitReason`). |
| `packages/core/src/plugin/builtin/antigravity/plugin/auth.ts` | `accessTokenExpired`, `formatRefreshParts`, `parseRefreshParts`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/config/*` | `index.ts`, `loader.ts` (`antigravity.json`), `schema.ts` (`AntigravityConfigSchema`, `DEFAULT_CONFIG`), `updater.ts`, `models.ts`, `models-v2.ts` (`OPENCODE_V2_MODEL_DEFINITIONS`, `buildAccountModelDefinitions`, `ModelCatalogCacheSchema`). |
| `packages/core/src/plugin/builtin/antigravity/plugin/core/streaming/*` | `index.ts`, `transformer.ts`, `types.ts` (transformación de streams SSE). |
| `packages/core/src/plugin/builtin/antigravity/plugin/cache.ts` & `plugin/cache/*` | Caché de firmas de pensamiento (`signature-cache.ts`, `index.ts`). |
| `packages/core/src/plugin/builtin/antigravity/plugin/stores/signature-store.ts` | Almacén de firmas en memoria/disco. |
| `packages/core/src/plugin/builtin/antigravity/plugin/recovery.ts` & `plugin/recovery/*` | Recuperación de errores (`constants.ts`, `index.ts`, `storage.ts`, `types.ts`), `thinking-recovery.ts`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/transform/*` | `claude.ts`, `gemini.ts`, `cross-model-sanitizer.ts`, `model-resolver.ts`, `index.ts`, `types.ts`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/ui/*` | `ansi.ts`, `auth-menu.ts`, `confirm.ts`, `quota.ts`, `quota.test.ts`, `select.ts`. |
| `packages/core/src/plugin/builtin/antigravity/plugin/*` | `cli.ts`, `debug.ts`, `errors.ts`, `fingerprint.ts`, `image-saver.ts`, `logger.ts`, `logging-utils.ts`, `project.ts` (`ensureProjectContext`, `loadCodeAssist`), `quota.ts` (`checkAccountsQuota`), `refresh-queue.ts`, `request.ts`, `request-helpers.ts`, `rotation.ts`, `search.ts` (`executeSearch`), `server.ts` (`startOAuthListener` en puerto `51121`), `storage.ts` (`proper-lockfile`, `antigravity-accounts.json`), `token.ts` (`refreshAccessToken`, `AntigravityTokenRefreshError`), `types.ts`, `version.ts`. |
| `packages/core/test/plugin/builtin/antigravity.test.ts` | Suite unitaria de PKCE, OAuth URLs, `DEFAULT_CONFIG`, parsing de callback y `splitOverflowSystemInstruction`. |

### 2.3 `@opencode/tui` (Terminal UI)
| Archivo | Rol |
| :--- | :--- |
| `packages/tui/src/plugin/builtins.ts` | Importa `Antigravity` de `../feature-plugins/antigravity` y lo registra en `builtins`. |
| `packages/tui/src/feature-plugins/antigravity/index.ts` | `AntigravityTuiPlugin` (`id: "opencode-antigravity-auth"`): comando `/antigravity` (alias `/ag`), menú de cuentas, flujo OAuth automático (`localhost:51121`) y manual, cuotas y refresco de modelos. |
| `packages/tui/src/feature-plugins/antigravity/quota.ts` | Formateo de descripción de cuotas en el selector TUI. |
| `packages/tui/src/component/dialog-config.tsx` | Importa `AntigravityAccountsRpc` y `AntigravitySettings`, define los 5 ajustes `["antigravity", ...]` en `settings`, los carga con `rpc.getConfig` y los guarda con `rpc.updateConfig`. |
| `packages/tui/test/fixture/tui-client.ts` | Mock de `/api/rpc/antigravity.accounts/getConfig` devolviendo `DEFAULT_ANTIGRAVITY_SETTINGS`. |

### 2.4 `@opencode/app` (Web / Desktop UI)
| Archivo | Rol |
| :--- | :--- |
| `packages/app/src/providers/antigravity/dialog.tsx` | Componente `DialogAntigravity` (lista de cuentas, badges, OAuth browser/manual, cuotas, refresco de modelos). |
| `packages/app/src/providers/antigravity/machine.ts` | Máquina de estados pura del diálogo (`createAntigravityDialogState`, `transitionAntigravityDialog`, `ANTIGRAVITY_TIMEOUT_MS`). |
| `packages/app/src/composer/commands.tsx` | `openAntigravity` y comando `antigravity.accounts` (`slash: "antigravity"`, `slashAliases: ["ag"]`). |
| `packages/app/src/settings/general/controllers.ts` | `createServerAntigravityController` y tipo `AntigravitySettingsController`. |
| `packages/app/src/settings/general/general.tsx` | `AntigravitySettingsSection` y su montaje en la vista General. |
| `packages/app/src/runtime/i18n/en.ts` | Claves `command.antigravity.*`, `dialog.antigravity.*` y `settings.antigravity.*`. |

### 2.5 Scripts y Especificaciones
| Archivo | Rol |
| :--- | :--- |
| `scripts/sync-antigravity.sh` | Script para clonar `NoeFabris/opencode-antigravity-auth`, copiar `src/` a `packages/core/src/plugin/builtin/antigravity/`, aplicar shims PKCE/tipos y ofuscar secretos. |
| `specs/v2/antigravity-provider.md` | Especificación de arquitectura, endpoints `/v1internal`, scopes OAuth y homologación con `agy`. |
| `specs/v2/README.md` | Tabla índice que enlaza `antigravity-provider.md`. |

---

## 3. Detalle Técnico Clave del Adaptador V2 (`v2.ts`)

Si se reconstruye desde cero, `v2.ts` es la pieza crítica que conecta el plugin legado con OpenCode v2:

1. **Aislamiento del SDK (`SDK_PACKAGE = "@opencode/antigravity-google"`):**
   - Los modelos expuestos tienen prefijo `antigravity-` (`ownsModel(id) = id.startsWith("antigravity-")`) y `package: "aisdk:@opencode/antigravity-google"`.
   - Usar un identificador estático distinto a `@ai-sdk/google` evita colisiones con el proveedor nativo de Google y evita `import.meta.resolve` en binarios compilados (`$bunfs`).
2. **Hooks registrados en `setup(ctx)`:**
   - `ctx.integration.transform`: añade el método `methodID: "antigravity"` bajo `integrationID: "google"` con `authorize`, `refresh` y `label`.
   - `ctx.event.subscribe`: escucha `credential.updated`, `integration.updated` y `credential.switched` para ejecutar `ctx.model.reload()`.
   - `ctx.provider.transform`: asegura la existencia del proveedor `"google"`, lo activa si hay cuentas guardadas e inyecta `modelDefinitions` (`antigravity-*`).
   - `ctx.model.transform`: si la conexión activa de `"google"` es Antigravity OAuth, deshabilita los modelos nativos no-`antigravity-*` para no enviar tokens OAuth de Antigravity a la API pública de Gemini.
   - `ctx.aisdk.hook("sdk", ..., { providerID: "google" })`: intercepta `event.package === "@opencode/antigravity-google"` e instancia `createGoogleGenerativeAI` con `scopedFetch` (usando `AsyncLocalStorage<Fetch>` y `apiKey: "antigravity-oauth"` como centinela).
   - `ctx.tool.transform`: registra la herramienta `google_search`.
   - `registerAccountManagement(...)`: registra los handlers de `AntigravityAccountsRpc`.
3. **Persistencia en disco del usuario:**
   - Config: `$OPENCODE_CONFIG_DIR/antigravity.json` o `~/.config/opencode/antigravity.json`.
   - Cuentas y caché: `antigravity-accounts.json`, `antigravity-signature-cache.json`, `antigravity-logs/`.

---

## 4. Cómo Reconstruirlo Paso a Paso

### Método A: Restauración directa desde Git (más rápido y fiel)

El commit exacto inmediatamente anterior al retiro es **`3dc7393611bdf573c2e0174a56272ea673a20d7e`**. Para restaurar todos los archivos eliminados:

```bash
COMMIT=3dc7393611bdf573c2e0174a56272ea673a20d7e

git checkout $COMMIT -- \
  packages/schema/src/antigravity.ts \
  packages/core/src/plugin/builtin/antigravity \
  packages/core/test/plugin/builtin/antigravity.test.ts \
  packages/tui/src/feature-plugins/antigravity \
  packages/app/src/providers/antigravity \
  scripts/sync-antigravity.sh \
  specs/v2/antigravity-provider.md
```

Luego re-aplica los enganches en los archivos compartidos siguiendo los **Pasos 1 a 5 del Método B** (puedes consultar el diff exacto con `git show $COMMIT -- <archivo>`).

---

### Método B: Reconstrucción archivo a archivo desde cero

#### Paso 1 — Capa `@opencode/schema` y paridad
1. Crear `packages/schema/src/antigravity.ts` definiendo `QuotaSummarySchema`, `AccountSummarySchema`, `AntigravitySettingsSchema`, `AntigravitySettingsUpdateSchema`, `DEFAULT_ANTIGRAVITY_SETTINGS`, `QuotaAccountReportSchema`, `AntigravityAccountsRpc` (`id: "antigravity.accounts"`), `formatQuotaSummary` y `stripAnsiCodes`.
2. En `packages/schema/src/surface-parity.ts`:
   - Añadir `{ id: "antigravity.accounts", names: ["antigravity", "ag"], surfaces: ["tui", "web"] }` a `SLASH_COMMAND_PARITY`.
   - Añadir las 5 rutas `antigravity.*` a `SHARED_SERVER_SETTINGS`.
3. En `script/check-surface-parity.ts`:
   - Importar `AntigravitySettingsSchema` desde `../packages/schema/src/antigravity.ts`.
   - Validar que todas las claves de `AntigravitySettingsSchema.fields` estén en `SHARED_SERVER_SETTINGS` y en `AntigravitySettingsSection` dentro de `packages/app/src/settings/general/general.tsx`.
4. Restaurar los tests en `packages/schema/test/surface-parity.test.ts` y `packages/schema/test/contract-hygiene.test.ts`.

#### Paso 2 — Capa `@opencode/core`
1. Añadir `"proper-lockfile": "4.1.2"` y `"@types/proper-lockfile": "4.1.4"` (y `"zod": "catalog:"` si no está) en `packages/core/package.json` y ejecutar `bun install`.
2. Restaurar o sincronizar `packages/core/src/plugin/builtin/antigravity/` (con `scripts/sync-antigravity.sh` o manualmente) incluyendo `index.ts`, `v2.ts`, `plugin.ts`, `constants.ts`, `antigravity/oauth.ts` y `plugin/*`.
3. En `packages/core/src/plugin/builtin/index.ts`, añadir:
   `export * as AntigravityPlugin from "./antigravity/index.js"`
4. En `packages/core/src/plugin/internal.ts`:
   - Importar `AntigravityPlugin` de `./builtin/index.js`.
   - Añadir `fromPromise(AntigravityPlugin.Plugin)` en `pre` (antes de `...ProviderPlugins`).
   - Añadir `AntigravityPlugin.Plugin.id` al `Set` `guarded`.
5. Restaurar `packages/core/test/plugin/builtin/antigravity.test.ts`.

#### Paso 3 — Capa `@opencode/tui`
1. Crear `packages/tui/src/feature-plugins/antigravity/index.ts` y `quota.ts` consumiendo `AntigravityAccountsRpc` vía `ctx.client.rpc(AntigravityAccountsRpc)` y registrando `/antigravity` (alias `/ag`).
2. En `packages/tui/src/plugin/builtins.ts`, importar `Antigravity` desde `../feature-plugins/antigravity` y añadirlo a `builtins`.
3. En `packages/tui/src/component/dialog-config.tsx`:
   - Importar `AntigravityAccountsRpc` y `type AntigravitySettings` desde `@opencode/schema/antigravity`.
   - Añadir los 5 ajustes `path: ["antigravity", ...]` en `settings`.
   - Añadir `localAntigravity` + `createResource` (`getConfig`), la lectura en `value()` y el guardado en `change()` (`updateConfig`).
4. En `packages/tui/test/fixture/tui-client.ts`, importar `DEFAULT_ANTIGRAVITY_SETTINGS` y responder `json({ output: DEFAULT_ANTIGRAVITY_SETTINGS })` para `/api/rpc/antigravity.accounts/getConfig`.

#### Paso 4 — Capa `@opencode/app` (Web / Desktop)
1. Crear `packages/app/src/providers/antigravity/machine.ts` y `dialog.tsx`.
2. En `packages/app/src/composer/commands.tsx`, añadir `openAntigravity` (import dinámico de `@/providers/antigravity/dialog`) y el comando `antigravity.accounts` (`slash: "antigravity"`, `slashAliases: ["ag"]`).
3. En `packages/app/src/settings/general/controllers.ts`, importar `AntigravityAccountsRpc`, `DEFAULT_ANTIGRAVITY_SETTINGS` y `type AntigravitySettings` desde `@opencode/schema/antigravity`, y exportar `createServerAntigravityController` y `AntigravitySettingsController`.
4. En `packages/app/src/settings/general/general.tsx`, importar `DEFAULT_ANTIGRAVITY_SETTINGS`, definir `AntigravitySettingsSection`, instanciar `antigravityController = createServerAntigravityController(...)` y renderizar `<AntigravitySettingsSection controller={antigravityController} />`.
5. En `packages/app/src/runtime/i18n/en.ts`, añadir las claves `command.antigravity.*`, `dialog.antigravity.*` y `settings.antigravity.*`.

#### Paso 5 — Verificación completa
1. Desde la raíz del repo:
   ```bash
   bun run check
   ```
   Esto ejecuta lint, typecheck y `bun script/check-surface-parity.ts`.
2. Ejecutar los tests desde cada paquete afectado (nunca desde la raíz):
   ```bash
   (cd packages/schema && bun test)
   (cd packages/core && bun test test/plugin/builtin/antigravity.test.ts)
   (cd packages/tui && bun test)
   ```
3. Si se distribuyen artefactos estáticos de `packages/app`, reconstruir `packages/app` (`bun run build` dentro de `packages/app`).
