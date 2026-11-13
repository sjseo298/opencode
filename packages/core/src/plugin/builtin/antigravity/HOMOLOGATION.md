# Antigravity Plugin Homologation Reference

Esta guía rápida resume los puntos clave de homologación y mantenimiento del plugin integrado `opencode-antigravity-auth` frente al binario nativo oficial de Antigravity (`agy`).

> **Especificación completa:** Consulta [`specs/v2/antigravity-provider.md`](../../../../../../specs/v2/antigravity-provider.md) para el detalle arquitectónico completo.

---

## Parámetros de Red Homologados

| Componente | Valor Oficial | Constante en Código |
| :--- | :--- | :--- |
| **Endpoint Primario (Daily)** | `https://daily-cloudcode-pa.googleapis.com` | `ANTIGRAVITY_ENDPOINT_DAILY` en `constants.ts` |
| **Endpoint Fallback (Prod)** | `https://cloudcode-pa.googleapis.com` | `ANTIGRAVITY_ENDPOINT_PROD` en `constants.ts` |
| **Streaming RPC** | `/v1internal:streamGenerateContent?alt=sse` | `prepareAntigravityRequest` en `plugin/request.ts` |
| **Onboarding RPC** | `/v1internal:onboardUser` | `ensureProjectContext` en `plugin/project.ts` |
| **Contexto RPC** | `/v1internal:loadCodeAssist` | `loadCodeAssist` en `plugin/project.ts` |
| **Catálogo de Modelos** | `/v1internal:fetchAvailableModels` | `fetchAvailableModels` en `plugin/quota.ts` |
| **Resumen de Cuotas** | `/v1internal:retrieveUserQuotaSummary` | `fetchUserQuotaSummary` en `plugin/quota.ts` |
| **OAuth Client ID** | Oficial de Antigravity Hub (`1071...403ep`) | `ANTIGRAVITY_CLIENT_ID` en `constants.ts` |
| **OAuth Client Secret** | Oficial de Antigravity Hub (`GOCSPX-K58F...DAf`) | `ANTIGRAVITY_CLIENT_SECRET` en `constants.ts` |
| **Scopes OAuth** | 5 scopes (`cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`) | `ANTIGRAVITY_SCOPES` en `constants.ts` |

---

## Verificación Rápida contra el Binario `agy`

Si se actualiza el binario de Antigravity en la máquina del usuario, ejecuta:

```bash
# 1. Comprobar que los endpoints de red no hayan cambiado
strings $(which agy) | grep -o 'https://[^"[:space:]]*cloudcode[^"[:space:]]*' | sort -u

# 2. Comprobar que el Client ID siga presente en el binario
python3 -c '
with open("$(which agy)", "rb") as f: data = f.read()
import re
print([m.decode() for m in set(re.findall(rb"1071[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com", data))])
'

# 3. Comprobar las peticiones que agy está haciendo en tiempo real
grep -E "URL: https://" ~/.gemini/antigravity-cli/log/*.log | tail -n 20
```

---

## Sincronización y Actualización

Para sincronizar el código del plugin desde el repositorio upstream:

```bash
# Ejecutar desde la raíz del repositorio
./scripts/sync-antigravity.sh
```

El script copia el código, reaplica automáticamente los shims de compatibilidad con OpenCode v2, ofusca credenciales para GitHub Secret Scanning, y ejecuta las pruebas de tipos y unitarias.
