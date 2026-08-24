#!/usr/bin/env python3
"""
opencodeplus — Menú interactivo para gestionar modelos de LLM locales.

Consulta LlamaCPP y LM Studio, genera la configuración de opencode,
compara con la actual y actualiza si hay cambios.

Requiere: pip install rich
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

# ── rich import ──────────────────────────────────────────────────────────────

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
    from rich.rule import Rule
    from rich.prompt import Prompt, Confirm
    from rich.live import Live
    from rich.progress import Progress, SpinnerColumn, TextColumn
    from rich import box
    from rich.markdown import Markdown
except ImportError:
    print(
        "\n[red]✗[/] rich no está instalada.\n\n"
        "Instálala con:\n"
        "    pip install rich\n\n"
        "O con pipx:\n"
        "    pipx install rich\n"
    )
    sys.exit(1)

console = Console()

# ── constants ────────────────────────────────────────────────────────────────

LLAMACPP_URL = "http://192.168.1.65:9999/v1/models"
LM_STUDIO_URL = "http://192.168.1.65:1234/api/v1/models"

# SCRIPT_DIR defaults to the scripts directory of this module;
# the wrapper overrides it when called from the opencodeplus script.
SCRIPT_DIR = Path(__file__).parent.resolve()
CONFIG_DIR = SCRIPT_DIR / "config"
GENERATED_CONFIG = CONFIG_DIR / "opencode.jsonc"

USER_CONFIG = Path.home() / ".config" / "opencode" / "opencode.jsonc"

DEFAULT_OUTPUT_LIMIT = 32768
DEFAULT_MLX_SCAN_ROOTS = ["/Volumes/Samsung2T/lmstudio"]


# ── helpers ──────────────────────────────────────────────────────────────────

def fetch_json(url: str) -> Optional[dict]:
    """Fetch JSON from URL, return None on failure."""
    import urllib.request
    from urllib.error import URLError

    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except (URLError, OSError, json.JSONDecodeError):
        return None


def parse_llamacpp_preset(preset: str) -> dict:
    """Parse the preset INI-like format and return key-value pairs."""
    result: dict = {}
    for line in preset.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


def extract_author_from_path(preset: str) -> str:
    """Extract author from the model path in the preset."""
    for line in preset.splitlines():
        line = line.strip()
        if line.startswith("model = "):
            model_path = line.split("model = ")[1].strip()
            parts = model_path.split("/")
            if len(parts) > 5:
                return parts[4]
    return ""


def infer_author_from_model_id(model_id: str) -> str:
    """Infer author/org from model id or absolute model path."""
    if not model_id:
        return ""
    if model_id.startswith("/"):
        parts = [p for p in model_id.split("/") if p]
        try:
            idx = parts.index("lmstudio")
            if idx + 1 < len(parts):
                return parts[idx + 1]
        except ValueError:
            return parts[-2] if len(parts) >= 2 else ""
        return ""
    if "/" in model_id:
        return model_id.split("/", 1)[0]
    return ""


def fmt_number(n: int) -> str:
    """Format number with thousands separators."""
    return f"{n:,}"


def parse_positive_int(value: object) -> int:
    """Parse positive int from number/string-like values, else return 0."""
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def parse_boolish(value: object) -> bool:
    """Parse booleans from bool/int/string-like values."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def normalize_reasoning_levels(value: object) -> list[str]:
    """Normalize reasoning effort levels from API values."""
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        level = item.strip().lower()
        if not level:
            continue
        if level not in result:
            result.append(level)
    return result


def resolve_reasoning_default(levels: list[str], value: object) -> str:
    """Resolve default reasoning effort from API value and available levels."""
    if isinstance(value, str):
        level = value.strip().lower()
        if level in levels:
            return level
    if "xhigh" in levels:
        return "xhigh"
    return levels[-1]


def derive_base_url(models_url: str) -> str:
    """Return scheme://host[:port] from a models endpoint URL."""
    p = urlsplit(models_url)
    if not p.scheme or not p.netloc:
        return ""
    return f"{p.scheme}://{p.netloc}"


def get_mlx_scan_roots() -> list[Path]:
    """Return scan roots for MLX models (env overrides default)."""
    raw = os.environ.get("OPENCODEPLUS_MLX_ROOTS", "")
    roots: list[Path] = []
    if raw.strip():
        for part in raw.split(":"):
            part = part.strip()
            if not part:
                continue
            roots.append(Path(part).expanduser())
    else:
        roots = [Path(p) for p in DEFAULT_MLX_SCAN_ROOTS]
    return roots


def is_mlx_model_dir(model_dir: Path) -> bool:
    """Heuristic for MLX model directories."""
    if not model_dir.exists() or not model_dir.is_dir():
        return False
    cfg = model_dir / "config.json"
    if not cfg.exists():
        return False
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(data, dict) and ("model_type" in data or "text_config" in data)


def is_probable_mlx_id(model_id: str) -> bool:
    """Heuristic to keep only MLX model ids when merging local inventory."""
    s = (model_id or "").lower()
    if not s:
        return False
    if s.endswith(".gguf"):
        return False
    if "-mlx-" in s or s.endswith("-mlx"):
        return True
    if "/mlx-" in s or s.startswith("mlx-community/"):
        return True
    # Local absolute path to an MLX directory also counts
    if model_id.startswith("/"):
        p = Path(model_id)
        return is_mlx_model_dir(p)
    return False


def resolve_mlx_model_dir_from_id(model_id: str) -> Optional[Path]:
    """Resolve model id/path to a local MLX model directory when possible."""
    if not model_id:
        return None
    p = Path(model_id)
    if p.is_absolute() and is_mlx_model_dir(p):
        return p
    for root in get_mlx_scan_roots():
        cand = (root / model_id).resolve()
        if is_mlx_model_dir(cand):
            return cand
    return None


def scan_local_mlx_model_ids() -> list[str]:
    """Scan local roots and return MLX model ids relative to roots."""
    ids: list[str] = []
    for root in get_mlx_scan_roots():
        if not root.exists() or not root.is_dir():
            continue
        for cfg in root.rglob("config.json"):
            model_dir = cfg.parent
            if not is_mlx_model_dir(model_dir):
                continue
            try:
                rel = model_dir.relative_to(root)
                model_id = rel.as_posix()
            except ValueError:
                model_id = str(model_dir)
            if model_id not in ids:
                ids.append(model_id)
    return ids


def get_llamacpp_runtime_defaults() -> dict:
    """Best-effort runtime defaults from llama-compatible status endpoint."""
    base = derive_base_url(LLAMACPP_URL)
    if not base:
        return {}
    status = fetch_json(f"{base}/status")
    if not status:
        p = urlsplit(base)
        if p.scheme and p.hostname:
            alt = f"{p.scheme}://{p.hostname}:9988/status"
            status = fetch_json(alt)
    status = status or {}
    out: dict = {}
    try:
        max_tokens = int((status.get("sampling") or {}).get("max_tokens") or 0)
    except (TypeError, ValueError):
        max_tokens = 0
    if max_tokens > 0:
        out["max_tokens"] = max_tokens
    display_name = ((status.get("model") or {}).get("display_name") or "").strip()
    if display_name:
        out["active_model_display_name"] = display_name
        out["runtime_mode"] = "mlx" if resolve_mlx_model_dir_from_id(display_name) else "gguf"
    return out


def infer_context_from_model_path(model_id: str) -> int:
    """Read context length from local MLX model config if model_id is a local path."""
    model_dir = resolve_mlx_model_dir_from_id(model_id)
    if not model_dir:
        return 0
    for name in ("config.json", "params.json"):
        cfg = model_dir / name
        if not cfg.exists():
            continue
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for key in (
            "max_position_embeddings",
            "n_ctx",
            "max_sequence_length",
            "context_length",
            "model_max_length",
        ):
            raw = data.get(key)
            if isinstance(raw, int) and raw > 0:
                return raw
            if isinstance(raw, str) and raw.isdigit():
                return int(raw)
        text_cfg = data.get("text_config")
        if isinstance(text_cfg, dict):
            for key in (
                "max_position_embeddings",
                "n_ctx",
                "max_sequence_length",
                "context_length",
                "model_max_length",
            ):
                raw = text_cfg.get(key)
                if isinstance(raw, int) and raw > 0:
                    return raw
                if isinstance(raw, str) and raw.isdigit():
                    return int(raw)
    return 0


def capability_prefix(
    provider_short: str,
    has_vision: bool,
    has_tool_call: bool,
    has_reasoning: bool,
) -> str:
    """Build compact capability prefix like [VTR]L:."""
    letters = ""
    if has_vision:
        letters += "V"
    if has_tool_call:
        letters += "T"
    if has_reasoning:
        letters += "R"
    if not letters:
        letters = "-"
    return f"[{letters}]{provider_short}:"


def reasoning_effort_summary(model_config: dict) -> str:
    """Return compact reasoning effort summary from model options/variants."""
    options = model_config.get("options", {}) if isinstance(model_config, dict) else {}
    default_effort = options.get("reasoningEffort") if isinstance(options, dict) else None

    variants = model_config.get("variants", {}) if isinstance(model_config, dict) else {}
    levels: list[str] = []
    if isinstance(variants, dict):
        for level, settings in variants.items():
            if not isinstance(level, str) or not isinstance(settings, dict):
                continue
            effort = settings.get("reasoningEffort")
            if effort == level and level not in levels:
                levels.append(level)

    if isinstance(default_effort, str) and default_effort.strip():
        default_effort = default_effort.strip().lower()
    else:
        default_effort = ""

    if default_effort and levels:
        return f"{default_effort} ({'/'.join(levels)})"
    if default_effort:
        return default_effort
    if levels:
        return "/".join(levels)
    return "—"


# ── model extraction ─────────────────────────────────────────────────────────

def extract_llamacpp_models(data: dict) -> dict:
    """Extract models from LlamaCPP API response."""
    models: dict = {}
    runtime = get_llamacpp_runtime_defaults()
    runtime_ctx = int(runtime.get("max_tokens", 0) or 0)
    for item in data.get("data", []):
        model_id = item.get("id", "")
        if not model_id:
            continue

        preset_text = item.get("status", {}).get("preset", "")
        preset = parse_llamacpp_preset(preset_text)
        author = extract_author_from_path(preset_text) or infer_author_from_model_id(model_id)

        # Prefer per-model limits reported by the endpoint.
        ctx_size = (
            parse_positive_int(item.get("max_context_length"))
            or parse_positive_int(item.get("context_length"))
            or parse_positive_int(item.get("input_token_limit"))
        )
        output_limit = (
            parse_positive_int(item.get("output_token_limit"))
            or parse_positive_int(item.get("max_output_tokens"))
            or parse_positive_int(item.get("max_tokens"))
        )

        # Fallback to preset/local/runtime only when endpoint values are unavailable.
        if ctx_size <= 0:
            ctx_size = parse_positive_int(preset.get("ctx-size"))
        if ctx_size <= 0:
            ctx_size = infer_context_from_model_path(model_id)
        if ctx_size <= 0:
            ctx_size = runtime_ctx
        if output_limit <= 0:
            output_limit = parse_positive_int(preset.get("n-predict"))
        if output_limit <= 0:
            output_limit = DEFAULT_OUTPUT_LIMIT
        capabilities = item.get("capabilities", [])
        caps = [str(cap).strip().lower() for cap in capabilities] if isinstance(capabilities, list) else []

        has_reasoning = (
            parse_boolish(item.get("reasoning_effort"))
            or ("reasoning_effort" in caps)
            or ("reasoning" in caps)
            or ("reasoning-budget" in preset)
        )
        reasoning_levels = normalize_reasoning_levels(item.get("reasoning_effort_levels"))
        if has_reasoning and not reasoning_levels:
            reasoning_levels = ["low", "medium", "high"]
        reasoning_default = resolve_reasoning_default(reasoning_levels, item.get("reasoning_effort_default")) if reasoning_levels else ""
        has_agent = preset.get("agent") == "1"
        has_flash_attn = preset.get("flash-attn") == "true"
        has_kv_unified = preset.get("kv-unified") == "1"

        # Respect capabilities reported by the server endpoint first.
        has_vision = "vision" in caps
        if not caps:
            has_vision = "clip-model" in preset or "mmproj" in preset or "mmvqa" in preset or "vlm" in preset
        has_audio_input = "audio-model" in preset or "audio-encoder" in preset or "whisper-model" in preset or "speech-to-text" in preset
        has_video_input = "video-model" in preset or "video-size" in preset
        has_pdf_input = True  # llama-compatible servers can accept PDFs in this project flow

        # Detect output modalities from preset fields
        has_audio_output = "audio-model" in preset or "audio-encoder" in preset or "whisper-model" in preset
        has_image_output = "image-gen-model" in preset
        has_video_output = "video-gen-model" in preset

        # Build modality arrays
        input_modalities = ["text"]
        if has_vision:
            input_modalities.append("image")
        if has_audio_input:
            input_modalities.append("audio")
        if has_video_input:
            input_modalities.append("video")
        if has_pdf_input:
            input_modalities.append("pdf")

        output_modalities = ["text"]
        if has_audio_output:
            output_modalities.append("audio")
        if has_image_output:
            output_modalities.append("image")
        if has_video_output:
            output_modalities.append("video")

        display_name = model_id
        if author:
            display_name = f"{author}/{model_id.split('/')[-1]}"
        prefix = capability_prefix(
            "L",
            has_vision=has_vision,
            has_tool_call=True,
            has_reasoning=has_reasoning,
        )
        name = f"{prefix} {display_name}"

        # Build model config dict
        model_config = {
            "id": model_id,
            "name": name,
            "author": author,
            "tool_call": True,
            "reasoning": has_reasoning,
            "temperature": True,
            "attachment": has_vision or has_pdf_input,
            "modalities": {
                "input": input_modalities,
                "output": output_modalities,
            },
            "limit": {
                "context": ctx_size if ctx_size > 0 else DEFAULT_OUTPUT_LIMIT,
                "output": output_limit,
            },
        }
        # Only include interleaved if the model has reasoning capability
        if has_reasoning:
            model_config["interleaved"] = True
            if reasoning_default:
                model_config["options"] = {"reasoningEffort": reasoning_default}
            if reasoning_levels:
                model_config["variants"] = {
                    level: {"reasoningEffort": level}
                    for level in reasoning_levels
                }

        models[model_id] = {
            "api": "openai",
            "name": name,
            "options": {
                "baseURL": f"{derive_base_url(LLAMACPP_URL)}/v1",
            },
            "models": {
                model_id: model_config
            },
        }
    return models


def add_local_mlx_models_if_needed(llamacpp_models: dict, runtime: dict) -> dict:
    """In MLX runtime mode, merge local MLX inventory into model list."""
    mode = (runtime.get("runtime_mode") or "").strip().lower()
    if mode != "mlx":
        # Fallback detection when /status is unavailable: if all API ids look MLX-ish,
        # treat as MLX mode so local inventory can be merged.
        ids = list(llamacpp_models.keys())
        if not ids:
            return llamacpp_models
        if not all(not x.endswith(".gguf") for x in ids):
            return llamacpp_models
        if not any(is_probable_mlx_id(x) for x in ids):
            return llamacpp_models

    if mode != "mlx":
        console.print("[dim]  LlamaCPP runtime detectado como MLX por heurística de ids[/]")

    if mode == "gguf":
        return llamacpp_models

    runtime_ctx = int(runtime.get("max_tokens", 0) or 0)
    base_url = f"{derive_base_url(LLAMACPP_URL)}/v1"
    local_ids = scan_local_mlx_model_ids()
    added = 0
    for model_id in local_ids:
        if not is_probable_mlx_id(model_id):
            continue
        if model_id in llamacpp_models:
            continue
        author = infer_author_from_model_id(model_id)
        ctx_size = infer_context_from_model_path(model_id)
        if ctx_size <= 0:
            ctx_size = runtime_ctx if runtime_ctx > 0 else DEFAULT_OUTPUT_LIMIT
        display_name = model_id
        if author:
            display_name = f"{author}/{model_id.split('/')[-1]}"
        prefix = capability_prefix(
            "L",
            has_vision=False,
            has_tool_call=True,
            has_reasoning=False,
        )
        name = f"{prefix} {display_name}"

        model_config = {
            "id": model_id,
            "name": name,
            "author": author,
            "tool_call": True,
            "reasoning": False,
            "temperature": True,
            "attachment": True,
            "modalities": {
                "input": ["text", "pdf"],
                "output": ["text"],
            },
            "limit": {
                "context": ctx_size,
                "output": DEFAULT_OUTPUT_LIMIT,
            },
        }
        llamacpp_models[model_id] = {
            "api": "openai",
            "name": name,
            "options": {"baseURL": base_url},
            "models": {model_id: model_config},
        }
        added += 1

    if added > 0:
        console.print(f"[green]  LlamaCPP+MLX local: +{added} modelos (scan local)[/]")
    return llamacpp_models


def extract_lmstudio_models(data: dict) -> dict:
    """Extract models from LM Studio native API response."""
    models: dict = {}
    for item in data.get("models", []):
        model_key = item.get("key", "")
        if not model_key:
            continue

        display_name = item.get("display_name", model_key)
        author = item.get("author", "")
        ctx_length = (
            parse_positive_int(item.get("max_context_length"))
            or parse_positive_int(item.get("context_length"))
            or parse_positive_int(item.get("input_token_limit"))
        )
        output_limit = (
            parse_positive_int(item.get("output_token_limit"))
            or parse_positive_int(item.get("max_output_tokens"))
            or parse_positive_int(item.get("max_tokens"))
            or DEFAULT_OUTPUT_LIMIT
        )
        capabilities = item.get("capabilities", {})
        has_vision = capabilities.get("vision", False)
        has_tool_use = capabilities.get("trained_for_tool_use", False)
        has_reasoning = capabilities.get("reasoning", False)
        has_audio_input = capabilities.get("audio", False)
        has_video_input = capabilities.get("video", False)
        quantization = item.get("quantization", {})
        quant_name = quantization.get("name", "")

        # Build modality arrays
        input_modalities = ["text"]
        if has_vision:
            input_modalities.append("image")
        if has_audio_input:
            input_modalities.append("audio")
        if has_video_input:
            input_modalities.append("video")
        input_modalities.append("pdf")

        output_modalities = ["text"]
        # LM Studio capabilities may include output modalities in the future
        # For now, only text output is known
        if capabilities.get("audio-output", False):
            output_modalities.append("audio")

        # Build compact name with capability prefix
        display = display_name
        if author:
            display = f"{author}/{display_name}"
        if quant_name:
            display += f"@{quant_name}"
        prefix = capability_prefix(
            "S",
            has_vision=has_vision,
            has_tool_call=has_tool_use,
            has_reasoning=has_reasoning,
        )
        name = f"{prefix} {display}"

        # Build model config dict
        model_config = {
            "id": model_key,
            "name": name,
            "author": author,
            "tool_call": has_tool_use,
            "reasoning": has_reasoning,
            "temperature": True,
            "attachment": has_vision,
            "modalities": {
                "input": input_modalities,
                "output": output_modalities,
            },
            "limit": {
                "context": ctx_length if ctx_length > 0 else DEFAULT_OUTPUT_LIMIT,
                "output": output_limit,
            },
        }
        # Only include interleaved if the model has reasoning capability
        if has_reasoning:
            model_config["interleaved"] = True

        models[model_key] = {
            "api": "openai",
            "name": name,
            "options": {
                "baseURL": "http://192.168.1.65:1234/v1",
            },
            "models": {
                model_key: model_config
            },
        }
    return models


def get_provider_key(server: str) -> str:
    """Get the provider key for a given server."""
    return "llamacpp" if server == "llamacpp" else "lmstudio"


def build_provider_config(models: dict, server: str) -> dict:
    """Build provider config dict for a set of models."""
    provider_key = get_provider_key(server)
    provider_name = "LlamaCPP" if server == "llamacpp" else "LM Studio"

    all_models = {}
    for model_id, model_data in models.items():
        all_models.update(model_data["models"])

    return {
        provider_key: {
            "api": "openai",
            "name": provider_name,
            "env": [],
            "options": {
                "baseURL": models[list(models.keys())[0]]["options"]["baseURL"]
                if models
                else "",
            },
            "models": all_models,
        }
    }


# ── config generation ────────────────────────────────────────────────────────

def generate_config(llamacpp_models: dict, lmstudio_models: dict) -> dict:
    """Generate the opencode.jsonc config."""
    config: dict = {
        "$schema": "https://opencode.ai/config.json",
        "provider": {},
    }

    if llamacpp_models:
        config["provider"].update(build_provider_config(llamacpp_models, "llamacpp"))

    if lmstudio_models:
        config["provider"].update(build_provider_config(lmstudio_models, "lmstudio"))

    return config


def load_user_config() -> dict:
    """Load the user's current config, or return empty dict if missing."""
    if not USER_CONFIG.exists():
        return {}
    try:
        with open(USER_CONFIG) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def config_has_changes(new_config: dict, current_config: dict) -> bool:
    """Check if the new config differs from the current one."""
    current_providers = current_config.get("provider", {})
    new_providers = new_config.get("provider", {})

    # Check if any provider section changed
    all_keys = set(current_providers.keys()) | set(new_providers.keys())
    for key in all_keys:
        current = current_providers.get(key, {})
        new = new_providers.get(key, {})
        if current != new:
            return True
    return False


# ── config writing ───────────────────────────────────────────────────────────

def write_config_to_file(config: dict, path: Path) -> None:
    """Write config to file with JSON formatting."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")


def update_user_config(config: dict) -> bool:
    """Update the user's config file. Returns True if changed."""
    current = load_user_config()
    if not config_has_changes(config, current):
        return False

    write_config_to_file(config, USER_CONFIG)
    return True


# ── git operations ───────────────────────────────────────────────────────────

def git_commit(message: str) -> bool:
    """Commit changes to the repo. Returns True on success."""
    try:
        repo_dir = SCRIPT_DIR.parent
        subprocess.run(
            ["git", "-C", str(repo_dir), "add", str(CONFIG_DIR)],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            ["git", "-C", str(repo_dir), "commit", "-m", message],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError as e:
        console.print(f"[yellow]⚠ Git error: {e.stderr.decode().strip()}[/]")
        return False


def git_push() -> bool:
    """Push to remote. Returns True on success."""
    try:
        repo_dir = SCRIPT_DIR.parent
        subprocess.run(
            ["git", "-C", str(repo_dir), "push"],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError as e:
        console.print(f"[yellow]⚠ Push error: {e.stderr.decode().strip()}[/]")
        return False


# ── shell config ─────────────────────────────────────────────────────────────

def get_shell_config_file() -> tuple[str, str]:
    """Detect shell and return (config_file, shell_name)."""
    shell = os.path.basename(os.environ.get("SHELL", ""))
    if shell == "zsh":
        zdotdir = os.environ.get("ZDOTDIR", "")
        return (os.path.expanduser(f"{zdotdir}/.zshrc") if zdotdir else str(Path.home() / ".zshrc"), "zsh")
    else:
        return (str(Path.home() / ".bashrc"), "bash")


def ensure_path_entry() -> bool:
    """Add opencodeplus to PATH in shell config. Returns True if changed."""
    config_file, shell_name = get_shell_config_file()
    config_path = Path(config_file)

    if not config_path.exists():
        console.print(f"[yellow]Config file {config_file} not found.[/]")
        return False

    path_entry = f'export PATH="$SCRIPT_DIR:$PATH"'
    # Check if already configured
    with open(config_path) as f:
        content = f.read()

    if path_entry in content:
        return False

    with open(config_path, "a") as f:
        f.write(f"\n{path_entry}\n")

    return True


# ── menu ─────────────────────────────────────────────────────────────────────

def show_welcome() -> None:
    """Display welcome banner."""
    console.print(
        Panel(
            Text("opencodeplus — Gestión de Modelos Locales", style="bold cyan", justify="center"),
            border_style="cyan",
            subtitle="LlamaCPP + LM Studio Sync Tool",
        )
    )
    console.print(Rule())


def show_models_menu() -> None:
    """Show the sync models submenu."""
    console.print(Panel("Sync de Modelos", border_style="green"))
    console.print("  [1] Sync desde LlamaCPP    — Consulta LlamaCPP y actualiza la config")
    console.print("  [2] Sync desde LM Studio   — Consulta LM Studio y actualiza la config")
    console.print("  [3] Sync desde ambos       — Consulta ambos servidores a la vez")
    console.print("  [0] Volver al menú principal")


def show_path_menu() -> None:
    """Show the sync path submenu."""
    console.print(Panel("Sync de PATH", border_style="blue"))
    console.print("  [1] Agregar opencodeplus al PATH — Agrega scripts/ al PATH del shell")
    console.print("  [2] Remover opencodeplus del PATH — Remueve la entrada del PATH")
    console.print("  [0] Volver al menú principal")


def show_config_menu() -> None:
    """Show the view config submenu."""
    console.print(Panel("Configuración", border_style="yellow"))
    console.print("  [1] Ver config generada    — Muestra la config de scripts/config/")
    console.print("  [2] Ver config actual      — Muestra la config de ~/.config/opencode/")
    console.print("  [3] Comparar configs       — Compara ambas configs lado a lado")
    console.print("  [0] Volver al menú principal")


def display_model_table(models: dict, server: str) -> None:
    """Display a table of models from a server."""
    table = Table(title=f"Modelos ({server})", show_header=True, header_style="bold cyan")
    table.add_column("Modelo", style="default")
    table.add_column("Autor", style="default")
    table.add_column("Contexto", justify="right")
    table.add_column("Output", justify="right")
    table.add_column("Herramientas")
    table.add_column("Adjuntos")
    table.add_column("Razonamiento")
    table.add_column("Effort")
    table.add_column("Modalidades")

    for model_id, model_data in models.items():
        inner = model_data.get("models", {}).get(model_id, {})
        ctx = inner.get("limit", {}).get("context", 0)
        output = inner.get("limit", {}).get("output", 0)
        author = inner.get("author", "")
        tool = "✓" if inner.get("tool_call") else ""
        attach = "✓" if inner.get("attachment") else ""
        reasoning = "✓" if inner.get("reasoning") else ""
        effort = reasoning_effort_summary(inner) if inner.get("reasoning") else ""
        modalities = inner.get("modalities", {})
        modality_str = "/".join(modalities.get("input", [])) if modalities else "—"

        table.add_row(
            inner.get("name", model_id),
            author,
            fmt_number(ctx) if ctx else "—",
            fmt_number(output) if output else "—",
            tool,
            attach,
            reasoning,
            effort,
            modality_str,
        )

    console.print(table)


# ── actions ──────────────────────────────────────────────────────────────────

def action_sync_model(server: str, url: str, extractor) -> None:
    """Sync models from a single server."""
    console.print(f"\n[bold]Consultando {server}...[/]")

    data: Optional[dict] = None
    with Progress(SpinnerColumn(), TextColumn("[bold]{task.description}[/]")) as progress:
        task = progress.add_task(f"Consultando {server}...", total=None)
        data = fetch_json(url)
        progress.update(task, completed=100)

    if not data:
        console.print(f"[red]✗ No se pudo conectar a {server}[/]")
        return

    models = extractor(data)
    # En modo MLX compat, la lista completa puede requerir merge con inventario local.
    # Si mostramos la tabla antes del merge, el usuario ve solo los modelos reportados
    # por /v1/models (incompleto para MLX). Reutilizamos el mismo pipeline de sync.
    if server == "llamacpp":
        merged = extract_models_from_servers("llamacpp").get("llamacpp", {})
        if merged:
            models = merged
    if not models:
        console.print("[yellow]⚠ No se encontraron modelos[/]")
        return

    console.print(f"[green]✓ {len(models)} modelos encontrados[/]")
    display_model_table(models, server)

    # Generate and compare config
    all_models = {server: models}
    if server == "llamacpp":
        all_models = {"llamacpp": models, "lmstudio": {}}
    elif server == "lmstudio":
        all_models = {"llamacpp": {}, "lmstudio": models}
    new_config = generate_config(
        all_models.get("llamacpp", {}),
        all_models.get("lmstudio", {}),
    )

    if config_has_changes(new_config, load_user_config()):
        if Confirm.ask("¿Actualizar config del usuario?"):
            if update_user_config(new_config):
                console.print("[green]✓ Config actualizada[/]")
                write_config_to_file(new_config, GENERATED_CONFIG)
            else:
                console.print("[yellow]⚠ No hubo cambios[/]")
        else:
            console.print("[yellow]⚠ Cancelado[/]")
    else:
        console.print("[green]✓ La config ya está actualizada[/]")


def extract_models_from_servers(server: str) -> dict:
    """Extract models from servers based on selection."""
    llamacpp = {}
    lmstudio = {}

    if server in ("llamacpp", "both"):
        data = fetch_json(LLAMACPP_URL)
        if data:
            runtime = get_llamacpp_runtime_defaults()
            llamacpp = extract_llamacpp_models(data)
            llamacpp = add_local_mlx_models_if_needed(llamacpp, runtime)
            console.print(f"[green]  LlamaCPP: {len(llamacpp)} modelos[/]")

    if server in ("lmstudio", "both"):
        data = fetch_json(LM_STUDIO_URL)
        if data:
            lmstudio = extract_lmstudio_models(data)
            console.print(f"[green]  LM Studio: {len(lmstudio)} modelos[/]")

    return {"llamacpp": llamacpp, "lmstudio": lmstudio}


def action_launch_opencode() -> None:
    """Launch the opencode binary."""
    import platform as _platform

    dist_dir = SCRIPT_DIR.parent / "packages" / "opencode" / "dist"

    machine = _platform.machine().lower()
    if sys.platform == "linux":
        arch_map = {"x86_64": "x64", "aarch64": "arm64", "armv7l": "arm"}
        arch = arch_map.get(machine, machine)
        target_dir = f"opencode-linux-{arch}"
    elif sys.platform == "darwin":
        arch_map = {"arm64": "arm64", "x86_64": "x64"}
        arch = arch_map.get(machine, machine)
        target_dir = f"opencode-darwin-{arch}"
    else:
        console.print(f"[yellow]⚠ Unsupported platform: {sys.platform}[/]")
        return

    binary = dist_dir / target_dir / "bin" / "opencode"
    if not binary.exists():
        available = [d.name for d in dist_dir.iterdir() if d.is_dir()] if dist_dir.exists() else []
        console.print(f"[red]✗ Binary not found: {binary}[/]")
        if available:
            console.print(f"  Available binaries: {', '.join(available)}")
        return
    console.print("[bold]Launching opencode...[/]")
    result = subprocess.run([str(binary)])
    if result.returncode != 0:
        console.print()
        subprocess.run(["stty", "sane"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["reset"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def action_sync_models() -> None:
    """Sync models from selected server(s)."""
    show_models_menu()
    choice = Prompt.ask(
        "  ¿Desde qué servidor?",
        choices=["1", "2", "3"],
        default="1",
    )

    server_map = {"1": ("llamacpp", LLAMACPP_URL, extract_llamacpp_models),
                  "2": ("lmstudio", LM_STUDIO_URL, extract_lmstudio_models),
                  "3": ("both", None, None)}

    server, url, extractor = server_map[choice]

    if server == "both":
        # Show both servers together
        all_models = extract_models_from_servers("both")
        llamacpp = all_models.get("llamacpp", {})
        lmstudio = all_models.get("lmstudio", {})

        if not llamacpp and not lmstudio:
            console.print("[red]✗ No se pudo conectar a ningún servidor[/]")
            return

        # Display combined table
        table = Table(title="Modelos Sincronizados", show_header=True, header_style="bold cyan")
        table.add_column("Servidor", style="cyan")
        table.add_column("Modelo", style="default")
        table.add_column("Autor", style="default")
        table.add_column("Contexto", justify="right")
        table.add_column("Output", justify="right")
        table.add_column("Herramientas")
        table.add_column("Adjuntos")
        table.add_column("Razonamiento")
        table.add_column("Effort")
        table.add_column("Modalidades")

        for model_id, model_data in llamacpp.items():
            inner = model_data.get("models", {}).get(model_id, {})
            ctx = inner.get("limit", {}).get("context", 0)
            output = inner.get("limit", {}).get("output", 0)
            author = inner.get("author", "")
            modalities = inner.get("modalities", {})
            modality_str = "/".join(modalities.get("input", [])) if modalities else "—"
            table.add_row(
                "LlamaCPP",
                inner.get("name", model_id),
                author,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                "✓" if inner.get("attachment") else "",
                "✓" if inner.get("reasoning") else "",
                reasoning_effort_summary(inner) if inner.get("reasoning") else "",
                modality_str,
            )

        for model_id, model_data in lmstudio.items():
            inner = model_data.get("models", {}).get(model_id, {})
            ctx = inner.get("limit", {}).get("context", 0)
            output = inner.get("limit", {}).get("output", 0)
            author = inner.get("author", "")
            modalities = inner.get("modalities", {})
            modality_str = "/".join(modalities.get("input", [])) if modalities else "—"
            table.add_row(
                "LM Studio",
                inner.get("name", model_id),
                author,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                "✓" if inner.get("attachment") else "",
                "✓" if inner.get("reasoning") else "",
                reasoning_effort_summary(inner) if inner.get("reasoning") else "",
                modality_str,
            )

        console.print(table)

        # Generate and compare
        new_config = generate_config(llamacpp, lmstudio)

        if config_has_changes(new_config, load_user_config()):
            if Confirm.ask("¿Actualizar config del usuario?"):
                if update_user_config(new_config):
                    console.print("[green]✓ Config actualizada[/]")
                    write_config_to_file(new_config, GENERATED_CONFIG)
                    total = len(llamacpp) + len(lmstudio)
                else:
                    console.print("[yellow]⚠ No hubo cambios[/]")
            else:
                console.print("[yellow]⚠ Cancelado[/]")
        else:
            console.print("[green]✓ La config ya está actualizada[/]")
    else:
        action_sync_model(server, url, extractor)


def action_select_model() -> None:
    """Select the default model from the user config."""
    config = load_user_config()
    providers = config.get("provider", {})

    if not providers:
        console.print("[yellow]⚠ No hay proveedores configurados.[/]")
        return

    all_models: list[dict] = []
    for provider_name, provider_data in providers.items():
        for model_id, model_data in provider_data.get("models", {}).items():
            inner = model_data if isinstance(model_data, dict) else {}
            modalities = inner.get("modalities", {})
            author = inner.get("author", "")
            all_models.append({
                "provider": provider_name,
                "id": model_id,
                "name": inner.get("name", model_id),
                "author": author,
                "ctx": inner.get("limit", {}).get("context", 0),
                "output": inner.get("limit", {}).get("output", 0),
                "tool_call": inner.get("tool_call", False),
                "attachment": inner.get("attachment", False),
                "reasoning": inner.get("reasoning", False),
                "modalities": "/".join(modalities.get("input", [])) if modalities else "—",
            })

    if not all_models:
        console.print("[yellow]⚠ No hay modelos disponibles.[/]")
        return

    current = config.get("model", "(ninguno)")
    console.print(f"\n[bold]Modelo actual:[/bold] {current}")
    console.print()

    filter_text = ""
    page_size = console.height - 10
    if page_size < 3:
        page_size = 15

    def filtered_models() -> list[dict]:
        if not filter_text:
            return all_models
        needle = filter_text.lower()
        return [
            m for m in all_models
            if needle in f"{m['id']} {m['name']} {m['provider']} {m['author']}".lower()
        ]

    def render_page(page: int) -> int:
        models = filtered_models()
        num_pages = max(1, (len(models) + page_size - 1) // page_size)
        page = min(page, num_pages - 1)
        start = page * page_size
        end = min(start + page_size, len(models))
        page_num = page + 1
        compact = console.width < 140
        title_suffix = f" — filtro: {filter_text}" if filter_text else ""

        console.print(f"[bold]Modelos Disponibles{title_suffix} (página {page_num} / {num_pages})[/]")
        if filter_text:
            console.print(f"  [dim]── {end - start} de {len(models)} modelos coinciden ──[/dim]")
        else:
            console.print(f"  [dim]── {end - start} de {len(all_models)} modelos mostrados ──[/dim]")
        console.print()

        if not models:
            console.print(f"[yellow]⚠ Ningún modelo coincide con '{filter_text}'.[/]")
            console.print()
            return page

        table = Table(show_header=True, header_style="bold cyan", expand=True)
        table.add_column("#", style="bold cyan", justify="right", width=4)
        table.add_column("Proveedor", style="cyan", max_width=18, overflow="ellipsis")
        table.add_column("Modelo", style="default", min_width=30, overflow="fold")
        if compact:
            table.add_column("Ctx", justify="right", width=9)
            table.add_column("Out", justify="right", width=9)
        else:
            table.add_column("Autor", style="default", max_width=20, overflow="ellipsis")
            table.add_column("Contexto", justify="right", width=10)
            table.add_column("Output", justify="right", width=10)
            table.add_column("Herramientas", width=12)
            table.add_column("Adjuntos", width=9)
            table.add_column("Razonamiento", width=12)
            table.add_column("Modalidades", max_width=16, overflow="ellipsis")

        table.title = f"Modelos Disponibles{title_suffix} (página {page_num} / {num_pages})"
        for idx, m in enumerate(models[start:end], start + 1):
            if compact:
                table.add_row(
                    str(idx),
                    m["provider"],
                    m["id"],
                    fmt_number(m["ctx"]) if m["ctx"] else "—",
                    fmt_number(m["output"]) if m["output"] else "—",
                )
            else:
                table.add_row(
                    str(idx),
                    m["provider"],
                    m["id"],
                    m["author"],
                    fmt_number(m["ctx"]) if m["ctx"] else "—",
                    fmt_number(m["output"]) if m["output"] else "—",
                    "✓" if m["tool_call"] else "",
                    "✓" if m["attachment"] else "",
                    "✓" if m["reasoning"] else "",
                    m["modalities"],
                )
        console.print(table)

        nav_parts: list[str] = []
        if page_num > 1:
            nav_parts.append("p")
        if page_num < num_pages:
            nav_parts.append("n")
        if num_pages > 1:
            nav_parts.append("j")
        nav_parts.append("f")
        nav_parts.append("q")
        nav = " | ".join(f"[bold]{k}[/]" for k in nav_parts)
        hint = "Ingresar número para seleccionar o texto para filtrar"
        if filter_text:
            hint += " · f sin texto limpia el filtro"
        console.print(f"\n  [dim]Navegación: {nav} | {hint}[/dim]\n")

    page = 0
    render_page(page)

    while True:
        raw = Prompt.ask("  ¿Número de modelo o filtro?")
        cmd = (raw or "").strip().lower()
        models = filtered_models()
        num_pages = max(1, (len(models) + page_size - 1) // page_size)

        if cmd in ("q", "quit"):
            console.print("[yellow]⚠ Cancelado.[/]")
            return
        elif cmd in ("f", "/", "filter", "filtrar"):
            filter_text = (Prompt.ask("  Filtro por nombre (Enter para limpiar)") or "").strip()
            page = 0
            render_page(page)
            continue
        elif cmd in ("n", "next"):
            page = render_page(min(page + 1, num_pages - 1))
            continue
        elif cmd in ("p", "prev"):
            page = render_page(max(page - 1, 0))
            continue
        elif cmd in ("j", "jump"):
            page_input = Prompt.ask("  ¿Número de página?", default="1", choices=[str(i) for i in range(1, num_pages + 1)])
            page = render_page(max(0, min(int(page_input) - 1, num_pages - 1)))
            continue
        elif cmd == "":
            # empty = next page
            if page < num_pages - 1:
                page = render_page(page + 1)
            continue

        try:
            num = int(cmd)
            if 1 <= num <= len(models):
                selected = models[num - 1]
                config["model"] = f"{selected['provider']}/{selected['id']}"
                write_config_to_file(config, GENERATED_CONFIG)
                console.print(f"[green]✓ Project config updated[/]")
                write_config_to_file(config, USER_CONFIG)
                console.print(f"[green]✓ User config updated[/]")
                console.print(f"\n[green]✓ Modelo por defecto: {selected['provider']}/{selected['id']}[/]")
                return
            else:
                console.print(f"[yellow]⚠ Número fuera de rango. Elige entre 1 y {len(models)}.[/]")
        except ValueError:
            filter_text = (raw or "").strip()
            page = 0
            render_page(page)


def action_run_build() -> None:
    """Run the full build.sh script (sync + install + build)."""
    console.print("\n[bold]Ejecutando build.sh (sync + install + build)...[/]")

    # Fetch upstream and check for new commits
    upstream_commits = fetch_upstream_commits()
    if not upstream_commits:
        console.print("[yellow]⚠ No hay commits nuevos de upstream. No hay nada que hacer.[/]")
        return

    commit_count = len(upstream_commits.strip().splitlines())
    console.print(f"\n[green]✓ {commit_count} nuevo(s) commit(s) de upstream[/]")

    # Try to generate an LLM summary for upstream updates
    model_info = get_default_model_from_config()
    if not model_info:
        console.print("[red]✗ Cancelando build: no se encontró modelo por defecto en la config.[/]")
        return

    console.print(f"[green]✓ Usando modelo: {model_info['provider']}/{model_info['model_id']}[/]")
    console.print("[dim]Generando resumen con LLM...[/]")
    summary = summarize_with_llm(upstream_commits, model_info)
    if not summary:
        console.print("[red]✗ Cancelando build: no se pudo obtener resumen del LLM tras esperar que el modelo remoto cargue.[/]")
        return

    # Display summary and ask for confirmation
    console.print("\n[bold green]✓ Resumen de cambios de upstream:[/]\n")
    console.print(Panel(Markdown(summary), border_style="green"))

    if not Confirm.ask("\n  ¿Confirmas que has leído los cambios y deseas continuar con el build?"):
        console.print("[yellow]⚠ Build cancelado por el usuario.[/]")
        return

    # Proceed with full sync + build
    build_script = str(SCRIPT_DIR.parent / "build.sh")
    result = subprocess.run(["bash", build_script, "--sync-mode=full"])
    if result.returncode != 0:
        console.print(f"[yellow]⚠ Build falló con código {result.returncode}[/]")
    else:
        console.print("[green]✓ Build completado[/]")


def action_sync_fork() -> None:
    """Sync fork (origin) only + install deps + build."""
    console.print("\n[bold]Sync de fork (origin) — sync + install + build...[/]")

    build_script = str(SCRIPT_DIR.parent / "build.sh")
    result = subprocess.run(["bash", build_script, "--sync-mode=fork"])
    if result.returncode != 0:
        console.print(f"[yellow]⚠ Build falló con código {result.returncode}[/]")
    else:
        console.print("[green]✓ Sync + build completado[/]")


def action_view_config() -> None:
    """View the generated config."""
    if GENERATED_CONFIG.exists():
        with open(GENERATED_CONFIG) as f:
            content = f.read()
        console.print(Markdown(content))
    else:
        console.print("[yellow]No hay config generada aún.[/]")


def action_view_user_config() -> None:
    """View the user's current config."""
    if USER_CONFIG.exists():
        with open(USER_CONFIG) as f:
            content = f.read()
        console.print(Markdown(content))
    else:
        console.print("[yellow]No hay config de usuario.[/]")


def action_compare_configs() -> None:
    """Compare generated config with user config."""
    if not GENERATED_CONFIG.exists():
        console.print("[yellow]No hay config generada aún.[/]")
        return

    with open(GENERATED_CONFIG) as f:
        new_config = json.load(f)
    current_config = load_user_config()

    console.print("\n[bold]Comparación de config[/]")
    console.print(Rule())

    current_providers = current_config.get("provider", {})
    new_providers = new_config.get("provider", {})

    all_keys = set(current_providers.keys()) | set(new_providers.keys())
    for key in sorted(all_keys):
        current = current_providers.get(key, {})
        new = new_providers.get(key, {})

        current_models = current.get("models", {})
        new_models = new.get("models", {})

        current_count = len(current_models)
        new_count = len(new_models)

        if current_count != new_count:
            status = "🔄" if current_count != new_count else "✓"
            console.print(f"[bold]{key}[/]: {current_count} → {new_count} modelos")
        elif current != new:
            console.print(f"[bold]{key}[/]: [yellow]modelo(s) actualizado(s)[/]")
        else:
            console.print(f"[bold]{key}[/]: [green]sin cambios[/]")


def action_sync_path() -> None:
    """Handle PATH sync."""
    show_path_menu()
    choice = Prompt.ask(
        "  ¿Qué deseas hacer?",
        choices=["1", "2", "0"],
        default="1",
    )

    if choice == "1":
        if ensure_path_entry():
            console.print("[green]✓ opencodeplus agregado al PATH[/]")
            console.print("[yellow]Ejecuta 'source ~/.zshrc' o abre una nueva terminal.[/]")
        else:
            console.print("[yellow]⚠ Ya está en el PATH o no se pudo acceder al archivo.[/]")
    elif choice == "2":
        config_file, _ = get_shell_config_file()
        path_entry = 'export PATH="$SCRIPT_DIR:$PATH"'
        with open(config_file) as f:
            content = f.read()
        if path_entry in content:
            with open(config_file, "w") as f:
                f.write(content.replace(path_entry, ""))
            console.print("[green]✓ opencodeplus removido del PATH[/]")
        else:
            console.print("[yellow]⚠ No estaba en el PATH.[/]")


# ── upstream commit detection and LLM summarization ──────────────────────

def fetch_upstream_commits() -> Optional[str]:
    """Fetch upstream and return commits in upstream/dev not in HEAD."""
    try:
        repo_dir = SCRIPT_DIR.parent
        subprocess.run(
            ["git", "-C", str(repo_dir), "fetch", "upstream"],
            capture_output=True,
        )
        result = subprocess.run(
            ["git", "-C", str(repo_dir), "log", "HEAD..upstream/dev", "--oneline", "--no-merges"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return None
    except Exception as e:
        console.print(f"[yellow]⚠ Git fetch error: {e}[/]")
        return None


def get_default_model_from_config() -> Optional[dict]:
    """Read the default model from the user config. Returns dict with provider, model_id, baseURL or None."""
    config = load_user_config()
    model_field = config.get("model")
    if not model_field:
        return None

    parts = model_field.split("/", 1)
    if len(parts) != 2:
        return None

    provider_name, model_id = parts

    providers = config.get("provider", {})
    provider_data = providers.get(provider_name)
    if not provider_data:
        return None

    base_url = provider_data.get("options", {}).get("baseURL", "")
    if not base_url:
        return None

    model_data = provider_data.get("models", {}).get(model_id, {})
    limits = model_data.get("limit", {})

    return {
        "provider": provider_name,
        "model_id": model_id,
        "base_url": base_url,
        "context_limit": limits.get("context", 262144),
        "output_limit": limits.get("output", 32768),
    }


def summarize_with_llm(commit_log: str, model_info: dict) -> Optional[str]:
    """Send commit log to LLM API and return summarized text. Returns None on failure."""
    import time
    import urllib.request
    from urllib.error import HTTPError, URLError

    url = f"{model_info['base_url']}/chat/completions"

    # Estimate tokens: ~4 chars per token for mixed content
    # Reserve tokens for system message + prompt overhead (~150 tokens)
    context_limit = model_info.get("context_limit", 262144)
    output_limit = model_info.get("output_limit", 32768)
    reserved_tokens = 200
    available_tokens = context_limit - reserved_tokens
    max_log_chars = available_tokens * 4

    truncated = False
    if len(commit_log) > max_log_chars:
        commit_log = commit_log[:max_log_chars]
        truncated = True

    messages = [
        {
            "role": "system",
            "content": "Eres un asistente experto en análisis de código. Resume los cambios del repositorio de forma concisa y organizada por categorías (features, fixes, refactor, docs, etc.). Usa un formato markdown con títulos, listas y emojis para hacer la lectura más clara. Responde en español.",
        },
        {
            "role": "user",
            "content": f"Analiza estos commits del repositorio y proporciona un resumen organizado por categorías:\n\n{commit_log}" + ("\n\n[... commits truncados por límite de contexto ...]" if truncated else ""),
        },
    ]

    payload = json.dumps({
        "model": model_info["model_id"],
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": min(output_limit, 8192),
    }).encode("utf-8")

    # Adaptive timeout: base 600s + 60s per 1000 chars of payload
    payload_size = len(payload)
    timeout = max(600, 600 + (payload_size // 1000) * 60)

    startup_wait = max(120, parse_positive_int(os.environ.get("OPENCODEPLUS_MODEL_READY_TIMEOUT", "900")))
    readiness_payload = json.dumps({
        "model": model_info["model_id"],
        "messages": [{"role": "user", "content": "Responde solo: ok"}],
        "temperature": 0,
        "max_tokens": 8,
    }).encode("utf-8")

    readiness_deadline = time.monotonic() + startup_wait
    readiness_attempt = 0
    while True:
        readiness_attempt += 1
        try:
            req = urllib.request.Request(url, data=readiness_payload, headers={
                "Content-Type": "application/json",
            })
            with urllib.request.urlopen(req, timeout=20):
                if readiness_attempt > 1:
                    console.print("[dim]Modelo remoto listo. Generando resumen...[/]")
                break
        except HTTPError as e:
            if e.code not in {408, 409, 425, 429, 500, 502, 503, 504}:
                console.print(f"[yellow]⚠ LLM API error de readiness (HTTP {e.code})[/]")
                return None
        except (URLError, TimeoutError, OSError):
            pass

        remaining = int(readiness_deadline - time.monotonic())
        if remaining <= 0:
            console.print(f"[yellow]⚠ Timeout esperando que el modelo remoto cargue ({startup_wait}s).[/]")
            return None
        if readiness_attempt == 1 or readiness_attempt % 3 == 0:
            console.print(f"[dim]Esperando carga del modelo remoto... ({remaining}s restantes)[/]")
        time.sleep(min(8, max(1, remaining)))

    max_attempts = 3
    console.print(f"[dim]Payload: {payload_size} bytes, Timeout: {timeout}s[/]")

    for attempt in range(1, max_attempts + 1):
        try:
            req = urllib.request.Request(url, data=payload, headers={
                "Content-Type": "application/json",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "")
                return None
        except HTTPError as e:
            retryable = e.code in {408, 409, 425, 429, 500, 502, 503, 504}
            console.print(f"[yellow]⚠ LLM API error (HTTP {e.code}, intento {attempt}/{max_attempts})[/]")
            if retryable and attempt < max_attempts:
                wait_seconds = attempt * 3
                console.print(f"[dim]Reintentando en {wait_seconds}s...[/]")
                time.sleep(wait_seconds)
                continue
            return None
        except (URLError, TimeoutError, OSError) as e:
            console.print(f"[yellow]⚠ LLM API error ({e}, intento {attempt}/{max_attempts})[/]")
            if attempt < max_attempts:
                wait_seconds = attempt * 3
                console.print(f"[dim]Reintentando en {wait_seconds}s...[/]")
                time.sleep(wait_seconds)
                continue
            return None
        except Exception as e:
            console.print(f"[yellow]⚠ LLM API error: {e}[/]")
            return None

    return None


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    show_welcome()

    menu_items = {
        "1": ("Ejecutar opencode", action_launch_opencode),
        "2": ("Sync de Modelos", action_sync_models),
        "3": ("Sync de PATH", action_sync_path),
        "4": ("Ver Config", lambda: (show_config_menu(),)),
        "5": ("Seleccionar Modelo", action_select_model),
        "6": ("Build Completo", action_run_build),
        "7": ("Sync de Fork", action_sync_fork),
        "0": ("Salir", lambda: None),
    }

    while True:
        console.print(Rule())
        console.print(
            Panel(
                Text("Menú Principal", style="bold cyan", justify="center"),
                border_style="cyan",
            )
        )
        console.print("  [1] Ejecutar opencode  — Lanza el TUI interactivo")
        console.print("  [2] Sync de Modelos    — Sincroniza modelos de LlamaCPP y LM Studio")
        console.print("  [3] Sync de PATH       — Gestiona la entrada de PATH en el shell")
        console.print("  [4] Ver Config         — Visualiza y compara configs de modelos")
        console.print("  [5] Modelo por defecto — Selecciona el modelo por defecto")
        console.print("  [6] Build Completo     — Sync fork + upstream + instalar deps + compilar")
        console.print("  [7] Sync de Fork       — Sync fork (origin) + instalar deps + compilar")
        console.print("  [0] Salir")

        choice = Prompt.ask("\n  ¿Opción?", choices=["0", "1", "2", "3", "4", "5", "6", "7"], default="0")

        if choice == "0":
            console.print("\n[bold cyan]¡Hasta luego![/]\n")
            break
        elif choice == "1":
            action_launch_opencode()
        elif choice == "2":
            action_sync_models()
        elif choice == "3":
            action_sync_path()
        elif choice == "4":
            action_view_config()
        elif choice == "5":
            action_select_model()
        elif choice == "6":
            action_run_build()
        elif choice == "7":
            action_sync_fork()


if __name__ == "__main__":
    main()
