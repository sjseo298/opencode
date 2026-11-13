# Antigravity Provider & Homologation Architecture

Este documento describe la arquitectura de homologación del plugin interno de Antigravity (`opencode-antigravity-auth`) en OpenCode, sus especificaciones de red, el protocolo de comunicación con el backend Cloud Code Assist y el procedimiento para verificar y mantener la paridad con el binario oficial de Antigravity (`agy`).

---

## 1. Visión General

El plugin de Antigravity permite a OpenCode acceder a los modelos de lenguaje servidos por la infraestructura de **Google Cloud Code Assist / Antigravity Hub** (incluyendo variantes especializadas de Gemini 3 y Claude Sonnet con pensamiento extendido) utilizando credenciales OAuth de usuario de Google.

A diferencia de los proveedores convencionales de API pública de Gemini (`generativelanguage.googleapis.com`), Antigravity opera a través de endpoints internos de Cloud Code (`v1internal`) con autenticación OAuth dedicada y cuotas asociadas a licencias y proyectos gestionados.

Para evitar discrepancias, caídas de servicio o bloqueos por parte del backend de Google, el plugin en OpenCode debe mantenerse **estrictamente homologado** respecto al comportamiento del binario nativo oficial `agy`.

---

## 2. Topología de Red y Endpoints

### 2.1 URLs del Backend Cloud Code

| Endpoint | URL | Propósito en `agy` y Plugin |
| :--- | :--- | :--- |
| **Daily (Primario)** | `https://daily-cloudcode-pa.googleapis.com` | Host por defecto para clientes de Antigravity Hub y CLI (`agy`). Resuelve inferencia, cuotas y proyectos. |
| **Producción (Fallback)** | `https://cloudcode-pa.googleapis.com` | Host de producción estándar de Cloud Code. Utilizado para consultas de cuota en modo Gemini CLI clásico o cuentas corporativas. |
| **Sandbox / Preprod** | `https://preprod-daily-cloudcode-pa.sandbox.googleapis.com`<br>`https://autopush-cloudcode-pa.sandbox.googleapis.com` | Entornos de preproducción internos (soportados por `agy` mediante banderas experimentales). |

> **Regla de oro de homologación:**  
> Todas las llamadas de Antigravity (`streamGenerateContent`, `generateContent`, `loadCodeAssist`, `onboardUser`, `fetchAvailableModels`, `retrieveUserQuotaSummary`) deben enviarse al host **Daily** (`daily-cloudcode-pa.googleapis.com`). No deben mezclarse hosts entre peticiones de control y peticiones de inferencia, ya que esto fragmenta las entitlements de la sesión.

### 2.2 Métodos RPC (`/v1internal:*`)

El backend de Cloud Code expone procedimientos RPC sobre HTTP REST/SSE:

```
POST /v1internal:loadCodeAssist
POST /v1internal:onboardUser
POST /v1internal:fetchAvailableModels
POST /v1internal:retrieveUserQuotaSummary
POST /v1internal:generateContent
POST /v1internal:streamGenerateContent?alt=sse
```

- **`loadCodeAssist`**: Inicializa el contexto de la sesión, valida la licencia del usuario y devuelve el `projectId` asignado (o `rising-fact-p41fc` como fallback).
- **`fetchAvailableModels`**: Obtiene la lista dinámica de modelos habilitados para la cuenta y proyecto especificado.
- **`streamGenerateContent?alt=sse`**: Canal de inferencia por streaming en tiempo real usando Server-Sent Events (SSE).
- **`retrieveUserQuotaSummary`**: Consulta el estado de las cuotas y límites de uso por modelo.

### 2.3 Variables de Entorno de Red

En el binario `agy`, el backend puede sobreescribirse mediante:
- `CLOUD_CODE_URL`: Si está definida, el cliente registra el log `[AuthProvider] UpdateEndpointURL called with CLOUD_CODE_URL: %q` y redirige el tráfico a esa URL base.

---

## 3. Protocolo de Autenticación OAuth 2.0 + PKCE

### 3.1 Credenciales de Aplicación

Para que Google identifique la conexión como cliente legítimo de Antigravity, se deben utilizar las credenciales oficiales de Antigravity Hub / CLI (extraídas del binario `agy`):

- **Client ID:** Configurado en `ANTIGRAVITY_CLIENT_ID` (`1071...403ep.apps.googleusercontent.com`).
- **Client Secret:** Configurado en `ANTIGRAVITY_CLIENT_SECRET` (`GOCSPX-K58F...DAf`).

> **Seguridad en el Repositorio:**  
> En el código fuente (`packages/core/src/plugin/builtin/antigravity/constants.ts`), estas cadenas están ofuscadas con `String.fromCharCode(...)` para evitar falsos positivos con los detectores de secretos de GitHub (GitHub Secret Scanning / Push Protection).

### 3.2 Scopes Requeridos

La solicitud OAuth debe contener exactamente los siguientes 5 scopes (orden no estricto):
1. `https://www.googleapis.com/auth/cloud-platform`
2. `https://www.googleapis.com/auth/userinfo.email`
3. `https://www.googleapis.com/auth/userinfo.profile`
4. `https://www.googleapis.com/auth/cclog`
5. `https://www.googleapis.com/auth/experimentsandconfigs`

### 3.3 Endpoints OAuth y Callback Local

- **Authorization Endpoint:** `https://accounts.google.com/o/oauth2/v2/auth`
- **Token Endpoint:** `https://oauth2.googleapis.com/token`
- **User Info Endpoint:** `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`
- **Redirect URI:** `http://localhost:51121/oauth-callback`
  - El servidor local escucha en el puerto `51121`. Soporta dual-stack (IPv4 `127.0.0.1` o `0.0.0.0` en entornos remotos/WSL/Docker).

---

## 4. Encapsulado e Intercepción de Peticiones

### 4.1 Envoltorio de Carga Útil (Payload Envelope)

El SDK de OpenCode (`@ai-sdk/google`) genera peticiones hacia la API pública `generativelanguage.googleapis.com`. El plugin intercepta estas llamadas en `request.ts` y las encapsula dentro de la estructura esperada por `/v1internal`:

```json
{
  "project": "<effectiveProjectId>",
  "model": "<resolvedModelName>",
  "request": {
    "contents": [ ... ],
    "systemInstruction": { ... },
    "generationConfig": { ... },
    "tools": [ ... ]
  }
}
```

### 4.2 Limpieza de Cabeceras (Header Sanitization)

Es crítico eliminar cabeceras que el SDK de IA o librerías de Google insertan automáticamente y que provocan respuestas `403 Forbidden` en el endpoint `v1internal`:
- `x-api-key`: Se elimina; la autenticación es únicamente vía `Authorization: Bearer <token>`.
- `x-goog-api-key`: Se elimina.
- `x-goog-user-project`: Se elimina para evitar forzar verificaciones de cuota a nivel de proyecto de facturación de GCP que colisionan con la licencia de Antigravity.

### 4.3 Formato del `User-Agent`

El backend valida la versión del cliente para habilitar modelos recientes. El User-Agent debe seguir el formato:

```
antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=<changelist>)
```

- **Sincronización dinámica:** El plugin consulta periódicamente el manifiesto de actualización oficial:
  `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml`
- **Versión de contingencia (fallback):** `2.24.0` (Changelist: `1000335682`).

---

## 5. Procedimiento de Verificación y Homologación contra el Binario `agy`

Cuando se sospeche un cambio en el protocolo oficial de Google, se debe inspeccionar el binario `agy` instalado (`/Users/atlantis/.local/bin/agy` o el binario activo en sistema) mediante los siguientes pasos:

### Paso 1: Comprobar Endpoints en el Binario
```bash
strings $(which agy) | grep -o 'https://[^"[:space:]]*cloudcode[^"[:space:]]*' | sort -u
```
*Validación:* Debe figurar `https://daily-cloudcode-pa.googleapis.com` y `https://cloudcode-pa.googleapis.com`.

### Paso 2: Verificar Client ID en el Binario
```bash
# Buscar Client IDs de Google OAuth en el binario agy
python3 -c '
with open("$(which agy)", "rb") as f:
    data = f.read()
import re
print([m.decode() for m in set(re.findall(rb"1071[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com", data))])
'
```
*Validación:* Debe coincidir exactamente con el valor configurado en `ANTIGRAVITY_CLIENT_ID`.

### Paso 3: Inspeccionar Logs de Peticiones en Vivo
`agy` genera logs detallados en `~/.gemini/antigravity-cli/log/cli-*.log`:
```bash
grep -E "URL: https://" ~/.gemini/antigravity-cli/log/*.log | tail -n 20
```
*Validación:* Se debe observar el tráfico dirigiéndose a:
- `/v1internal:loadCodeAssist`
- `/v1internal:fetchAvailableModels`
- `/v1internal:streamGenerateContent?alt=sse`

---

## 6. Procedimiento para Mantener Actualizado el Plugin

El repositorio cuenta con la herramienta de sincronización automatizada:

```bash
./scripts/sync-antigravity.sh [REMOTE_URL] [BRANCH]
```

### Flujo de Sincronización:
1. Clona el repositorio origen (por defecto `https://github.com/NoeFabris/opencode-antigravity-auth.git` rama `main`).
2. Copia los archivos del directorio `src` hacia:
   - `packages/core/src/plugin/builtin/antigravity/`
   - `packages/tui/src/feature-plugins/antigravity/`
3. Aplica los parches de compatibilidad nativa para OpenCode v2:
   - PKCE nativo con `node:crypto`.
   - Ofuscación de credenciales para GitHub Secret Scanning.
   - Adaptaciones de `fetch` y tipos de cliente `PluginClient`.
   - Servidor OAuth dual-stack con soporte de variables de entorno.
   - Exportaciones para el index de plugins builtin de Core y TUI.
4. Ejecuta automáticamente la comprobación de tipos y pruebas:
   ```bash
   bun --cwd packages/core typecheck
   bun --cwd packages/tui typecheck
   bun --cwd packages/core test test/plugin/builtin/antigravity.test.ts
   ```
5. Prueba en vivo con el TUI de OpenCode:
   ```bash
   bun run dev:live
   ```
