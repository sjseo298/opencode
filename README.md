# Opencode — Fork Personalizado

Este fork de [opencode](https://github.com/anomalyco/opencode) contiene modificaciones propias para facilitar la instalación, construcción y configuración del proyecto.

## Scripts personalizados

### `build.sh`

Script principal para sincronizar el fork con el repositorio upstream y construir opencode para la plataforma actual.

#### Uso

```bash
./build.sh                    # Sincroniza con upstream + instala dependencias + construye
./build.sh --skip-sync        # Solo instala dependencias y construye
./build.sh --skip-install     # Solo construye
```

#### Qué hace cada paso

**1. Sincronización con upstream**

Cuando se ejecuta sin `--skip-sync`, el script:

- Ejecuta `git fetch upstream` para obtener los últimos cambios del repositorio original.
- Fusiona automáticamente los cambios con `git merge upstream/dev --no-edit`.
- Verifica si existen commits locales propios y los empuja a `origin/dev` automáticamente. Esto permite que el fork público se mantenga actualizado con tus modificaciones sin necesidad de acciones manuales.

**2. Instalación de dependencias**

Ejecuta `bun install` para instalar todas las dependencias del proyecto. Si la instalación falla, el script muestra un mensaje de error y se detiene.

**3. Construcción**

Ejecuta el script de construcción de opencode (`bun run script/build.ts --single`) para generar el binario para la plataforma actual.

**4. Configuración de PATH (solo Linux)**

En sistemas Linux, el script detecta automáticamente si el shell es `zsh` o `bash` y agrega el directorio del binario construido al PATH del usuario. Por ejemplo, en un sistema con zsh agregaría:

```
export PATH="/home/usuario/.../packages/opencode/dist/opencode-linux-x64/bin:$PATH"
```

Esta línea se añade al archivo de configuración del shell (`.zshrc` o `.bashrc`). Solo se agrega si no existe ya, evitando duplicados.

**5. Verificación de salida**

Al finalizar, el script muestra el contenido del directorio `dist/` para verificar que la construcción fue exitosa.

## Agregar modelos de LlamaServer

Opencode soporta modelos de LlamaServer a través de un archivo de configuración.

### Ubicación del archivo de configuración

```
~/.config/opencode/opencode.jsonc
```

### Formato del archivo

El archivo `.jsonc` permite comentarios (líneas que comienzan con `//`).

### Configuración básica de LlamaServer

Para agregar un modelo de LlamaServer, añade una entrada en la sección `models` del archivo de configuración:

```jsonc
{
  "models": {
    "llama-cpp": {
      "provider": "llama-cpp",
      "endpoint": "http://localhost:8080",
      "models": ["llama-model"]
    }
  }
}
```

### Configuración con API key

Si tu servidor requiere autenticación:

```jsonc
{
  "models": {
    "llama-cpp": {
      "provider": "llama-cpp",
      "endpoint": "http://localhost:8080",
      "models": ["llama-model"],
      "apiKey": "tu-api-key"
    }
  }
}
```

### Configuración de LlamaServer con OpenAI-compatible endpoint

Si tu LlamaServer expone un endpoint compatible con OpenAI (como LM Studio o Ollama):

```jsonc
{
  "models": {
    "custom-llm": {
      "provider": "openai",
      "endpoint": "http://localhost:1234/v1",
      "models": ["llama-model"]
    }
  }
}
```

### Configuración completa con opciones avanzadas

```jsonc
{
  "models": {
    "llama-cpp": {
      "provider": "llama-cpp",
      "endpoint": "http://localhost:8080",
      "models": ["llama-model"],
      "apiKey": "tu-api-key",
      "options": {
        "temperature": 0.7,
        "maxTokens": 4096,
        "topP": 0.95
      }
    }
  }
}
```

### Verificar la configuración

Después de agregar la configuración de modelos, puedes verificar que opencode la reconoce ejecutando el comando de configuración o inspeccionando el archivo de configuración directamente:

```bash
cat ~/.config/opencode/opencode.jsonc
```

### Flujo recomendado

1. Inicia tu servidor de LlamaServer (por ejemplo, con `llama-server -m modelo.gguf --port 8080`).
2. Agrega la configuración de modelos en `~/.config/opencode/opencode.jsonc`.
3. Reinicia opencode para que cargue la nueva configuración.
4. Verifica que el modelo aparece disponible en la interfaz de opencode.
