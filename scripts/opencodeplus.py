#!/usr/bin/env python3
"""
opencodeplus — Menú interactivo y CLI para gestionar modelos de LLM locales, proveedores y servicio local de OpenCode.

Consulta LlamaCPP, LM Studio y proveedores habilitados en OpenCode (GitHub Copilot, Google, etc.),
genera la configuración de opencode, compara con la actual y actualiza si hay cambios.

También integra modos de inicio y gestión del servicio local equivalentes a RemoteDevcontainers:
  - opencodeplus web | open     : Asegura el servicio local, genera link pair y abre la Web UI en el navegador
  - opencodeplus pair | link    : Asegura el servicio local y muestra el link de un solo uso sin abrir navegador
  - opencodeplus tui [args...]  : Asegura el servicio local y conecta la TUI local (--server)
  - opencodeplus start          : Inicia o asegura que el servicio local esté activo
  - opencodeplus restart        : Reinicia el servicio local en segundo plano
  - opencodeplus status         : Muestra el estado del servicio local y salud de /api/info
  - opencodeplus stop | down    : Detiene el servicio local en segundo plano
  - opencodeplus [menu]         : Abre el menú interactivo completo (opciones 1-12 y atajos t/w/p/s)

Requiere: pip install rich
"""

import base64
import json
import os
import glob
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import llm_monitor

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

LLAMACPP_URL = os.environ.get("OPENCODEPLUS_LLAMACPP_URL", "http://Mac-Studio-de-Juan.local:29999/v1/models")
LM_STUDIO_URL = os.environ.get("OPENCODEPLUS_LMSTUDIO_URL", "http://Mac-Studio-de-Juan.local:1234/api/v1/models")

# SCRIPT_DIR defaults to the scripts directory of this module;
# the wrapper overrides it when called from the opencodeplus script.
CONFIG_DIR = SCRIPT_DIR / "config"
GENERATED_CONFIG = CONFIG_DIR / "opencode.jsonc"

USER_CONFIG = Path.home() / ".config" / "opencode" / "opencode.jsonc"

DEFAULT_OUTPUT_LIMIT = 32768
DEFAULT_MLX_SCAN_ROOTS = ["/Volumes/Samsung2T/lmstudio"]
TEMP_PATTERN_KEYWORDS = (
    "tmp",
    "temp",
    "cache",
    ".ds_store",
    "bun-build",
    "tsbuildinfo",
)
TEMP_PATTERN_EXACT = {
    ".ds_store",
    "*~",
    ".tmp",
    "tmp",
    ".turbo",
    ".sst",
    "logs",
    "result",
    "*.bun-build",
    "*.log",
    "tsconfig.tsbuildinfo",
}


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


def fmt_bytes(num_bytes: int) -> str:
    """Format bytes to a compact human-readable string."""
    size = float(max(num_bytes, 0))
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return "0 B"


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


def is_temporary_gitignore_pattern(pattern: str) -> bool:
    """Heuristic: keep only temporary/cache-like entries from .gitignore."""
    normalized = pattern.strip().lower().lstrip("/").rstrip("/")
    while normalized.startswith("**/"):
        normalized = normalized[3:]
    if not normalized:
        return False
    if normalized in TEMP_PATTERN_EXACT:
        return True

    parts = [part for part in normalized.split("/") if part]
    for part in parts:
        if part in TEMP_PATTERN_KEYWORDS:
            return True
        if part.startswith("tmp.") or part.endswith(".tmp"):
            return True
        if part.startswith("cache.") or part.endswith(".cache"):
            return True
    return False


def load_temp_gitignore_patterns(gitignore_path: Path) -> list[str]:
    """Load temporary-oriented patterns from root .gitignore."""
    if not gitignore_path.exists():
        return []

    patterns: list[str] = []
    try:
        lines = gitignore_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        if is_temporary_gitignore_pattern(line) and line not in patterns:
            patterns.append(line)
    return patterns


def pattern_to_globs(pattern: str) -> list[str]:
    """Convert a .gitignore entry to a few filesystem globs."""
    anchored = pattern.startswith("/")
    directory_only = pattern.endswith("/")
    body = pattern.lstrip("/").rstrip("/")
    if not body:
        return []

    has_slash = "/" in body
    out: list[str] = []
    if anchored or has_slash:
        out.append(body)
        if directory_only:
            out.append(f"{body}/**")
    else:
        out.append(body)
        out.append(f"**/{body}")
        if directory_only:
            out.append(f"{body}/**")
            out.append(f"**/{body}/**")

    unique: list[str] = []
    for item in out:
        if item not in unique:
            unique.append(item)
    return unique


def list_temp_matches(repo_root: Path, pattern: str) -> list[Path]:
    """Resolve filesystem matches for one temporary pattern."""
    matches: list[Path] = []
    for rel_glob in pattern_to_globs(pattern):
        for raw_path in glob.glob(str(repo_root / rel_glob), recursive=True):
            path = Path(raw_path)
            if not path.exists() and not path.is_symlink():
                continue
            try:
                rel = path.relative_to(repo_root)
            except ValueError:
                continue
            if ".git" in rel.parts:
                continue
            matches.append(path)
    return matches


def collapse_temp_targets(repo_root: Path, paths: list[Path]) -> list[Path]:
    """Drop duplicates and child paths when parent directory is already selected."""
    kept: list[Path] = []
    for path in sorted(paths, key=lambda p: (len(p.parts), str(p))):
        try:
            rel = path.relative_to(repo_root)
        except ValueError:
            continue
        if ".git" in rel.parts:
            continue

        skip = False
        for parent in kept:
            if parent == path or parent in path.parents:
                skip = True
                break
        if not skip:
            kept.append(path)
    return kept


def path_usage(path: Path) -> tuple[int, int]:
    """Return (file_count, total_bytes) for a file/dir path."""
    if not path.exists() and not path.is_symlink():
        return (0, 0)

    if path.is_symlink():
        try:
            return (1, int(path.lstat().st_size))
        except OSError:
            return (0, 0)

    if path.is_file():
        try:
            return (1, int(path.stat().st_size))
        except OSError:
            return (0, 0)

    if not path.is_dir():
        return (0, 0)

    files = 0
    total = 0
    for root, dirs, file_names in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".git"]
        for name in file_names:
            fpath = Path(root) / name
            try:
                stat = fpath.lstat() if fpath.is_symlink() else fpath.stat()
            except OSError:
                continue
            files += 1
            total += int(stat.st_size)
    return (files, total)


def collect_temp_cleanup_targets(repo_root: Path) -> tuple[list[Path], list[str], int, int]:
    """Collect root .gitignore temporary targets and aggregate size usage."""
    gitignore_path = repo_root / ".gitignore"
    patterns = load_temp_gitignore_patterns(gitignore_path)
    if not patterns:
        return ([], [], 0, 0)

    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(list_temp_matches(repo_root, pattern))

    targets = collapse_temp_targets(repo_root, matches)
    total_files = 0
    total_bytes = 0
    for target in targets:
        files, size = path_usage(target)
        total_files += files
        total_bytes += size

    return (targets, patterns, total_files, total_bytes)


def cleanup_temp_targets(targets: list[Path]) -> tuple[int, int, int, list[str]]:
    """Delete temporary targets. Returns (paths, files, bytes, errors)."""
    removed_paths = 0
    removed_files = 0
    freed_bytes = 0
    errors: list[str] = []

    for target in sorted(targets, key=lambda p: len(p.parts), reverse=True):
        files, size = path_usage(target)
        if not target.exists() and not target.is_symlink():
            continue

        try:
            if target.is_symlink() or target.is_file():
                target.unlink(missing_ok=True)
            elif target.is_dir():
                shutil.rmtree(target)
            else:
                continue
        except OSError as exc:
            errors.append(f"{target}: {exc}")
            continue

        removed_paths += 1
        removed_files += files
        freed_bytes += size

    return (removed_paths, removed_files, freed_bytes, errors)


def prompt_temp_cleanup_on_startup() -> None:
    """Ask to clean temporary files discovered from .gitignore on startup."""
    repo_root = SCRIPT_DIR.parent
    console.print("[dim]Buscando archivos temporales (.gitignore)...[/]")
    targets, patterns, total_files, total_bytes = collect_temp_cleanup_targets(repo_root)
    if not patterns:
        return

    console.print(
        f"[dim]Temporales detectados: {fmt_number(total_files)} archivos · {fmt_bytes(total_bytes)}[/]"
    )
    if total_files == 0:
        console.print("[green]✓ No se encontraron archivos temporales para limpiar.[/]")
        return

    if not Confirm.ask("¿Limpiar archivos temporales ahora?", default=False):
        return

    removed_paths, removed_files, freed_bytes, errors = cleanup_temp_targets(targets)
    console.print(
        "[green]✓ Limpieza completada: "
        f"{fmt_number(removed_files)} archivos · {fmt_bytes(freed_bytes)} "
        f"({removed_paths} rutas).[/]"
    )
    if errors:
        console.print(f"[yellow]⚠ No se pudieron eliminar {len(errors)} ruta(s).[/]")


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
        author = item.get("author") or item.get("provider") or extract_author_from_path(preset_text) or infer_author_from_model_id(model_id)

        # Prefer per-model limits reported by the endpoint.
        ctx_size = (
            parse_positive_int(item.get("max_context_length"))
            or parse_positive_int(item.get("context_length"))
            or parse_positive_int(item.get("input_token_limit"))
            or parse_positive_int((item.get("limits") or {}).get("context") if isinstance(item.get("limits"), dict) else None)
            or parse_positive_int((item.get("limit") or {}).get("context") if isinstance(item.get("limit"), dict) else None)
        )
        output_limit = (
            parse_positive_int(item.get("output_token_limit"))
            or parse_positive_int(item.get("max_output_tokens"))
            or parse_positive_int(item.get("max_tokens"))
            or parse_positive_int((item.get("limits") or {}).get("output") if isinstance(item.get("limits"), dict) else None)
            or parse_positive_int((item.get("limit") or {}).get("output") if isinstance(item.get("limit"), dict) else None)
        )

        capabilities = item.get("capabilities", [])
        caps = [str(cap).strip().lower() for cap in capabilities] if isinstance(capabilities, list) else []

        has_reasoning = (
            parse_boolish(item.get("reasoning_effort"))
            or ("reasoning_effort" in caps)
            or ("reasoning" in caps)
            or ("reasoning-budget" in preset)
            or (preset.get("reasoning-effort-supported") == "true")
        )
        reasoning_levels = normalize_reasoning_levels(item.get("reasoning_effort_levels"))
        if has_reasoning and not reasoning_levels:
            reasoning_levels = ["low", "medium", "xhigh"]
        reasoning_default = resolve_reasoning_default(reasoning_levels, item.get("reasoning_effort_default")) if reasoning_levels else ""

        is_qwen = "qwen" in model_id.lower() or "splash" in model_id.lower() or "esca" in model_id.lower()
        is_qwen3_modern = is_qwen and any(k in model_id.lower() for k in ["3.8", "3.6", "3.5", "qwen3"])

        # Fallback to preset/local/runtime only when endpoint values are unavailable.
        if ctx_size <= 0:
            ctx_size = parse_positive_int(preset.get("ctx-size"))
        if ctx_size <= 0:
            ctx_size = infer_context_from_model_path(model_id)
        if ctx_size <= 0:
            ctx_size = runtime_ctx
        if ctx_size <= 32768 and is_qwen:
            ctx_size = 262144

        # Modelos Qwen modernos (3.8, 3.6, 3.5, etc.) soportan hasta 131072 tokens con razonamiento y 65536 estándar.
        if output_limit <= 4096:
            if is_qwen3_modern:
                output_limit = 131072 if has_reasoning else 65536
            elif is_qwen:
                output_limit = 32768
            elif output_limit <= 0:
                output_limit = parse_positive_int(preset.get("n-predict")) or DEFAULT_OUTPUT_LIMIT
        if output_limit <= 0:
            output_limit = DEFAULT_OUTPUT_LIMIT
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

        display_name = item.get("display_name") or item.get("name") or model_id
        if not (item.get("display_name") or item.get("name")) and author:
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
            "modalities": {
                "input": input_modalities,
                "output": output_modalities,
            },
            "limit": {
                "context": ctx_size if ctx_size > 0 else (262144 if ("qwen" in model_id.lower() or "splash" in model_id.lower()) else DEFAULT_OUTPUT_LIMIT),
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
                "baseURL": os.environ.get("OPENCODEPLUS_LMSTUDIO_BASE_URL", "http://Mac-Studio-de-Juan.local:1234/v1"),
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
            "npm": "@ai-sdk/openai-compatible",
            "name": provider_name,
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
    console.print("  [bold green]\\[1][/] Sync desde LlamaCPP    — Consulta LlamaCPP y actualiza la config")
    console.print("  [bold green]\\[2][/] Sync desde LM Studio   — Consulta LM Studio y actualiza la config")
    console.print("  [bold green]\\[3][/] Sync desde ambos       — Consulta ambos servidores a la vez")
    console.print("  [bold dim]\\[0][/] Volver al menú principal")


def show_path_menu() -> None:
    """Show the sync path submenu."""
    console.print(Panel("Sync de PATH", border_style="blue"))
    console.print("  [bold blue]\\[1][/] Agregar opencodeplus al PATH — Agrega scripts/ al PATH del shell")
    console.print("  [bold blue]\\[2][/] Remover opencodeplus del PATH — Remueve la entrada del PATH")
    console.print("  [bold dim]\\[0][/] Volver al menú principal")


def show_config_menu() -> None:
    """Show the view config submenu."""
    console.print(Panel("Configuración", border_style="yellow"))
    console.print("  [bold yellow]\\[1][/] Ver config generada    — Muestra la config de scripts/config/")
    console.print("  [bold yellow]\\[2][/] Ver config actual      — Muestra la config de ~/.config/opencode/")
    console.print("  [bold yellow]\\[3][/] Comparar configs       — Compara ambas configs lado a lado")
    console.print("  [bold dim]\\[0][/] Volver al menú principal")


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
        modalities = inner.get("modalities", {})
        inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
        attach = "✓" if (inner.get("attachment") or "image" in inputs or "pdf" in inputs) else ""
        is_reasoning = bool(inner.get("reasoning") or inner.get("interleaved") or inner.get("variants"))
        reasoning = "✓" if is_reasoning else ""
        effort = reasoning_effort_summary(inner) if is_reasoning else ""
        modality_str = "/".join(inputs) if inputs else "—"

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


def resolve_opencode_binary(require_compiled: bool = False) -> Optional[str]:
    """Resolve the local opencode binary from packages/cli/dist, legacy dist, or PATH."""
    import platform as _platform

    cli_dist = SCRIPT_DIR.parent / "packages" / "cli" / "dist"
    legacy_dist = SCRIPT_DIR.parent / "packages" / "opencode" / "dist"

    machine = _platform.machine().lower()
    if sys.platform == "linux":
        arch_map = {"x86_64": "x64", "aarch64": "arm64", "armv7l": "arm"}
        arch = arch_map.get(machine, machine)
        cli_target = f"cli-linux-{arch}"
        legacy_target = f"opencode-linux-{arch}"
    elif sys.platform == "darwin":
        arch_map = {"arm64": "arm64", "x86_64": "x64"}
        arch = arch_map.get(machine, machine)
        cli_target = f"cli-darwin-{arch}"
        legacy_target = f"opencode-darwin-{arch}"
    else:
        console.print(f"[yellow]⚠ Unsupported platform: {sys.platform}[/]")
        return None

    binary = cli_dist / cli_target / "bin" / "opencode"
    if binary.exists():
        return str(binary)

    legacy_binary = legacy_dist / legacy_target / "bin" / "opencode"
    if legacy_binary.exists():
        return str(legacy_binary)

    if not require_compiled:
        path_bin = shutil.which("opencode")
        if path_bin:
            return path_bin

    dist_dir = cli_dist if cli_dist.exists() else legacy_dist
    available = [d.name for d in dist_dir.iterdir() if d.is_dir()] if dist_dir.exists() else []
    console.print(f"[red]✗ Binary not found: {binary}[/]")
    if available:
        console.print(f"  Available binaries: {', '.join(available)}")
    return None


def get_local_service_status(binary_cmd: Optional[str] = None) -> tuple[bool, str]:
    """Return (is_running, url_or_message) for the local opencode background service."""
    binary = binary_cmd or resolve_opencode_binary()
    if not binary:
        return (False, "Binario no encontrado")
    try:
        proc = subprocess.run(
            [binary, "service", "status"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        out = (proc.stdout or proc.stderr or "").strip()
        if proc.returncode == 0 and out.startswith("http"):
            return (True, out.splitlines()[0].strip())
        return (False, out or "Detenido")
    except Exception as exc:
        return (False, f"Error: {exc}")


def get_local_service_password(binary_cmd: Optional[str] = None) -> str:
    """Return the password of the local opencode background service."""
    binary = binary_cmd or resolve_opencode_binary()
    if not binary:
        return ""
    try:
        proc = subprocess.run(
            [binary, "service", "get", "password"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:
        pass
    return ""


def check_local_service_health(url: str) -> bool:
    """Check if local opencode service responds on /api/info (200 or 401)."""
    import urllib.request
    from urllib.error import HTTPError, URLError

    if not url or not url.startswith("http"):
        return False
    target = f"{url.rstrip('/')}/api/info"
    try:
        req = urllib.request.Request(target)
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status in (200, 401)
    except HTTPError as exc:
        return exc.code in (200, 401)
    except (URLError, OSError):
        return False


def is_local_service_disabled(binary_cmd: Optional[str] = None) -> bool:
    """Return True if the local opencode background service has `disabled=true` in config."""
    binary = binary_cmd or resolve_opencode_binary()
    if not binary:
        return False
    try:
        proc = subprocess.run(
            [binary, "service", "get", "disabled"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            return proc.stdout.strip().lower() == "true"
    except Exception:
        pass
    return False


def ensure_local_service_enabled(binary_cmd: Optional[str] = None, silent: bool = False) -> bool:
    """Ensure `disabled` is unset in local service config so `opencode pair` and background daemon work."""
    binary = binary_cmd or resolve_opencode_binary()
    if not binary:
        return False
    if not is_local_service_disabled(binary):
        return True
    if not silent:
        console.print("[cyan]🔓 Habilitando servicio en segundo plano (`opencode service unset disabled`)...[/]")
    try:
        proc = subprocess.run(
            [binary, "service", "unset", "disabled"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return proc.returncode == 0
    except Exception as exc:
        if not silent:
            console.print(f"[yellow]⚠ No se pudo ejecutar `opencode service unset disabled`: {exc}[/]")
        return False


def ensure_local_service(force_restart: bool = False) -> Optional[str]:
    """Ensure the local opencode background service is running and healthy. Returns service URL."""
    binary = resolve_opencode_binary()
    if not binary:
        return None

    ensure_local_service_enabled(binary)

    running, current_url = get_local_service_status(binary)
    if not force_restart and running and check_local_service_health(current_url):
        console.print(f"[green]✓ Servicio local activo:[/] [bold]{current_url}[/]")
        return current_url

    action_cmd = "restart" if (force_restart and running) else ("restart" if force_restart else "start")
    action_label = "Reiniciando" if force_restart else "Iniciando"
    console.print(f"[cyan]⏳ {action_label} servicio local de OpenCode (`opencode service {action_cmd}`)...[/]")
    try:
        proc = subprocess.run(
            [binary, "service", action_cmd],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if proc.returncode != 0 and action_cmd == "restart":
            proc = subprocess.run(
                [binary, "service", "start"],
                capture_output=True,
                text=True,
                timeout=20,
            )
    except Exception as exc:
        console.print(f"[red]✗ Error al ejecutar opencode service {action_cmd}: {exc}[/]")
        return None

    running, new_url = get_local_service_status(binary)
    if running and check_local_service_health(new_url):
        console.print(f"[green]✓ Servicio local listo:[/] [bold]{new_url}[/]")
        return new_url

    err_detail = (proc.stderr or proc.stdout or new_url or "").strip()
    console.print(f"[red]✗ El servicio local no respondió en /api/info ({err_detail}).[/]")
    return None


def generate_local_pair_link(service_url: str, binary_cmd: Optional[str] = None) -> tuple[str, str]:
    """Run `opencode pair --url <service_url>` locally and return (raw_output, extracted_pair_url)."""
    import re

    binary = binary_cmd or resolve_opencode_binary()
    if not binary:
        return ("", "")

    ensure_local_service_enabled(binary, silent=True)

    cmd = [binary, "pair"]
    if service_url and service_url.startswith("http"):
        cmd.extend(["--url", service_url])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
        )
        output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
        output = output.strip()
        if "service unset disabled" in output:
            subprocess.run([binary, "service", "unset", "disabled"], capture_output=True, text=True, timeout=5)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            output = ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
    except Exception as exc:
        return (f"Error ejecutando opencode pair: {exc}", "")

    match = re.search(r"https?://[^\s]+/auth/connect/[A-Za-z0-9_-]+", output)
    pair_url = match.group(0) if match else ""
    return (output, pair_url)


def action_launch_web(open_browser: bool = True) -> None:
    """Ensure local service, generate one-time pairing link, and optionally open browser."""
    binary = resolve_opencode_binary()
    if not binary:
        return

    service_url = ensure_local_service(force_restart=False)
    if not service_url:
        return

    output, pair_url = generate_local_pair_link(service_url, binary)
    if output:
        console.print(f"\n{output}\n")

    if not pair_url:
        console.print("[yellow]⚠ No se pudo extraer automáticamente el link de pairing.[/]")
        return

    if open_browser:
        console.print(f"[cyan]🌐 Abriendo en navegador:[/] [bold]{pair_url}[/]")
        open_cmd = "open" if sys.platform == "darwin" else "xdg-open"
        if shutil.which(open_cmd):
            subprocess.run([open_cmd, pair_url])
        else:
            import webbrowser
            webbrowser.open(pair_url)


def action_launch_pair() -> None:
    """Ensure local service and print the one-time pairing link without opening browser."""
    action_launch_web(open_browser=False)


def action_launch_opencode(extra_args: Optional[list[str]] = None) -> None:
    """Ensure local background service and launch the TUI connected to it."""
    binary = resolve_opencode_binary(require_compiled=False)
    if not binary:
        return

    service_url = ensure_local_service(force_restart=False)
    console.print("[bold]Iniciando OpenCode TUI...[/]")
    env = os.environ.copy()
    cmd = [binary]

    if service_url and service_url.startswith("http"):
        password = get_local_service_password(binary)
        cmd.extend(["--server", service_url])
        if password:
            env["OPENCODE_PASSWORD"] = password
        env["OPENCODE_TUI_CHANNEL"] = "dev"
        console.print(f"[cyan]🔗 Conectando TUI local al servicio ({service_url})...[/]")

    if extra_args:
        cmd.extend(extra_args)

    result = subprocess.run(cmd, env=env)
    if result.returncode != 0:
        console.print()
        subprocess.run(["stty", "sane"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["reset"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def action_service_status() -> None:
    """Show detailed status of the local opencode background service (like RemoteDevcontainers status)."""
    binary = resolve_opencode_binary()
    running, status_val = get_local_service_status(binary)
    disabled = is_local_service_disabled(binary)
    endpoint = status_val if running else "http://127.0.0.1:49374 (por defecto)"
    healthy = check_local_service_health(status_val) if running else False

    table = Table(
        title="🖥️  Estado del Servicio Local de OpenCode",
        border_style="cyan",
        header_style="bold cyan",
        box=box.ROUNDED,
        show_header=False,
    )
    table.add_column("Campo", style="bold cyan", no_wrap=True)
    table.add_column("Valor", style="white")

    table.add_row("Perfil", "local (Mac)")
    table.add_row("Directorio", str(Path.cwd()))
    table.add_row("Binario", binary or "[red]No encontrado[/]")
    table.add_row("Endpoint Local", endpoint)
    table.add_row(
        "Config Daemon",
        "[yellow]DESHABILITADO (disabled=true — se habilitará al iniciar/pair)[/]"
        if disabled
        else "[green]HABILITADO[/]",
    )
    if running and healthy:
        table.add_row("Estado Servicio", f"[green]ACTIVO (respondiendo en {status_val}/api/info)[/]")
    elif running:
        table.add_row("Estado Servicio", f"[yellow]EN EJECUCIÓN ({status_val}, sin respuesta en /api/info)[/]")
    else:
        table.add_row("Estado Servicio", f"[yellow]INACTIVO ({status_val})[/]")

    console.print()
    console.print(table)
    console.print()


def action_service_restart() -> None:
    """Restart the local opencode background service."""
    ensure_local_service(force_restart=True)


def action_service_stop() -> None:
    """Stop the local opencode background service."""
    binary = resolve_opencode_binary()
    if not binary:
        return
    running, status_val = get_local_service_status(binary)
    if not running:
        console.print(f"[yellow]ℹ El servicio local ya está detenido ({status_val}).[/]")
        return
    try:
        stop_proc = subprocess.run([binary, "service", "stop"], capture_output=True, text=True, timeout=10)
        if stop_proc.returncode == 0:
            console.print(f"[green]✓ Servicio local ({status_val}) detenido correctamente.[/]")
        else:
            console.print(f"[yellow]⚠ Error al detener el servicio: {stop_proc.stderr.strip()}[/]")
    except Exception as exc:
        console.print(f"[red]✗ Error al detener el servicio: {exc}[/]")


def action_manage_service() -> None:
    """Interactive submenu for managing the local background service and launch modes."""
    while True:
        action_service_status()
        console.print(Panel("Gestión de Servicio Local y Conexión (Estilo RemoteDevcontainers)", border_style="cyan"))
        console.print("  [bold cyan]\\[1][/] [dim](\\[t])[/] Conectar Terminal (TUI)   — Asegura servicio y conecta la TUI local (--server)")
        console.print("  [bold cyan]\\[2][/] [dim](\\[w])[/] Abrir Web UI (Navegador)  — Asegura servicio, genera link pair y abre el navegador")
        console.print("  [bold cyan]\\[3][/] [dim](\\[p])[/] Mostrar link Pair         — Asegura servicio y muestra el link de un solo uso")
        console.print("  [bold cyan]\\[4][/]       Iniciar / Asegurar        — Levanta el servicio local si está detenido (start)")
        console.print("  [bold cyan]\\[5][/]       Reiniciar servicio        — Reinicia el servicio local en segundo plano (restart)")
        console.print("  [bold cyan]\\[6][/]       Detener servicio (stop)   — Detiene el servicio local en segundo plano")
        console.print("  [bold dim]\\[0][/]       Volver al menú principal")

        sub = Prompt.ask(
            "\n  ¿Opción de servicio? [dim](0-6 o t/w/p)[/]",
            choices=["0", "1", "2", "3", "4", "5", "6", "t", "T", "w", "W", "p", "P"],
            default="0",
            show_choices=False,
        ).lower()
        if sub == "0":
            return
        elif sub in ("1", "t"):
            action_launch_opencode()
        elif sub in ("2", "w"):
            action_launch_web(open_browser=True)
        elif sub in ("3", "p"):
            action_launch_pair()
        elif sub == "4":
            ensure_local_service(force_restart=False)
        elif sub == "5":
            action_service_restart()
        elif sub == "6":
            action_service_stop()


def action_sync_models() -> None:
    """Sync models from selected server(s)."""
    show_models_menu()
    choice = Prompt.ask(
        "  ¿Desde qué servidor?",
        choices=["1", "2", "3", "0"],
        default="1",
    )
    if choice == "0":
        return

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
            inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
            attach = "✓" if (inner.get("attachment") or "image" in inputs or "pdf" in inputs) else ""
            is_reasoning = bool(inner.get("reasoning") or inner.get("interleaved") or inner.get("variants"))
            reasoning = "✓" if is_reasoning else ""
            effort = reasoning_effort_summary(inner) if is_reasoning else ""
            modality_str = "/".join(inputs) if inputs else "—"
            table.add_row(
                "LlamaCPP",
                inner.get("name", model_id),
                author,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                attach,
                reasoning,
                effort,
                modality_str,
            )

        for model_id, model_data in lmstudio.items():
            inner = model_data.get("models", {}).get(model_id, {})
            ctx = inner.get("limit", {}).get("context", 0)
            output = inner.get("limit", {}).get("output", 0)
            author = inner.get("author", "")
            modalities = inner.get("modalities", {})
            inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
            attach = "✓" if (inner.get("attachment") or "image" in inputs or "pdf" in inputs) else ""
            is_reasoning = bool(inner.get("reasoning") or inner.get("interleaved") or inner.get("variants"))
            reasoning = "✓" if is_reasoning else ""
            effort = reasoning_effort_summary(inner) if is_reasoning else ""
            modality_str = "/".join(inputs) if inputs else "—"
            table.add_row(
                "LM Studio",
                inner.get("name", model_id),
                author,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                attach,
                reasoning,
                effort,
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


def fetch_opencode_service_models() -> Optional[list[dict]]:
    """Fetch model list from OpenCode daemon API (/api/model)."""
    import urllib.request

    try:
        status_proc = subprocess.run(
            ["opencode", "service", "status"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if status_proc.returncode != 0 or not status_proc.stdout.strip():
            return None
        base_url = status_proc.stdout.strip()

        pw_proc = subprocess.run(
            ["opencode", "service", "get", "password"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        password = pw_proc.stdout.strip() if pw_proc.returncode == 0 else ""

        req = urllib.request.Request(f"{base_url}/api/model")
        if password:
            auth_str = base64.b64encode(f"opencode:{password}".encode()).decode()
            req.add_header("Authorization", f"Basic {auth_str}")

        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            if isinstance(data, dict) and isinstance(data.get("data"), list):
                return data["data"]
    except Exception:
        pass
    return None


def fetch_opencode_cli_models() -> Optional[list[str]]:
    """Fetch model identifiers using `opencode models` CLI."""
    try:
        proc = subprocess.run(
            ["opencode", "models"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return [line.strip() for line in proc.stdout.strip().splitlines() if line.strip()]
    except Exception:
        pass
    return None


def fetch_all_available_models(config: dict) -> list[dict]:
    """Gather all models from OpenCode service/CLI and configured providers."""
    models_map: dict[tuple[str, str], dict] = {}

    # 1. Try querying OpenCode service API for rich model information
    api_models = fetch_opencode_service_models()
    if api_models:
        for m in api_models:
            if not isinstance(m, dict):
                continue
            if not m.get("enabled", True):
                continue
            prov = m.get("providerID", "")
            mid = m.get("id", "")
            if not prov or not mid:
                continue
            caps = m.get("capabilities", {}) if isinstance(m.get("capabilities"), dict) else {}
            limits = m.get("limit", {}) if isinstance(m.get("limit"), dict) else {}
            inputs = caps.get("input", []) if isinstance(caps.get("input"), list) else []
            variants = m.get("variants", []) if isinstance(m.get("variants"), list) else []
            author = m.get("author") or infer_author_from_model_id(mid) or m.get("family", "") or prov

            models_map[(prov, mid)] = {
                "provider": prov,
                "id": mid,
                "name": m.get("name", mid),
                "author": author,
                "ctx": limits.get("context", 0),
                "output": limits.get("output", 0),
                "tool_call": bool(caps.get("tools", False)),
                "attachment": bool("pdf" in inputs or "image" in inputs),
                "reasoning": bool(variants or caps.get("reasoning", False)),
                "modalities": "/".join(inputs) if inputs else "—",
            }
    else:
        # Fallback to `opencode models` CLI
        cli_models = fetch_opencode_cli_models()
        if cli_models:
            for item in cli_models:
                if "/" in item:
                    prov, mid = item.split("/", 1)
                    models_map[(prov, mid)] = {
                        "provider": prov,
                        "id": mid,
                        "name": mid,
                        "author": infer_author_from_model_id(mid) or prov,
                        "ctx": 0,
                        "output": 0,
                        "tool_call": False,
                        "attachment": False,
                        "reasoning": False,
                        "modalities": "—",
                    }

    # 2. Merge/enrich with models from user config (e.g. custom llamacpp / lmstudio)
    providers = config.get("provider", {})
    if isinstance(providers, dict):
        for provider_name, provider_data in providers.items():
            if not isinstance(provider_data, dict):
                continue
            models_dict = provider_data.get("models", {})
            if not isinstance(models_dict, dict):
                continue
            for model_id, model_data in models_dict.items():
                inner = model_data if isinstance(model_data, dict) else {}
                modalities = inner.get("modalities", {})
                author = inner.get("author", "")
                key = (provider_name, model_id)
                if key in models_map:
                    existing = models_map[key]
                    if not existing.get("ctx") and inner.get("limit", {}).get("context"):
                        existing["ctx"] = inner.get("limit", {}).get("context", 0)
                    if not existing.get("output") and inner.get("limit", {}).get("output"):
                        existing["output"] = inner.get("limit", {}).get("output", 0)
                    if not existing.get("author") and author:
                        existing["author"] = author
                    inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
                    has_attach = bool(inner.get("attachment") or "image" in inputs or "pdf" in inputs)
                    has_reason = bool(inner.get("reasoning") or inner.get("interleaved") or inner.get("variants"))
                    if inner.get("tool_call"):
                        existing["tool_call"] = True
                    if has_attach:
                        existing["attachment"] = True
                    if has_reason:
                        existing["reasoning"] = True
                    if modalities and existing.get("modalities") in ("—", ""):
                        existing["modalities"] = "/".join(inputs)
                else:
                    inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
                    models_map[key] = {
                        "provider": provider_name,
                        "id": model_id,
                        "name": inner.get("name", model_id),
                        "author": author or infer_author_from_model_id(model_id) or provider_name,
                        "ctx": inner.get("limit", {}).get("context", 0),
                        "output": inner.get("limit", {}).get("output", 0),
                        "tool_call": inner.get("tool_call", False),
                        "attachment": bool(inner.get("attachment") or "image" in inputs or "pdf" in inputs),
                        "reasoning": bool(inner.get("reasoning") or inner.get("interleaved") or inner.get("variants")),
                        "modalities": "/".join(inputs) if inputs else "—",
                    }

    return sorted(models_map.values(), key=lambda m: (m["provider"], m["id"]))


def action_select_model() -> None:
    """Select the default model from available OpenCode providers and user config."""
    config = load_user_config()

    with console.status("[bold cyan]Consultando modelos de OpenCode y proveedores configurados...[/]"):
        all_models = fetch_all_available_models(config)

    if not all_models:
        console.print("[yellow]⚠ No hay modelos disponibles ni proveedores configurados.[/]")
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
        return page

    page = 0
    page = render_page(page)

    while True:
        raw = Prompt.ask("  ¿Número de modelo o filtro?")
        cmd = (raw or "").strip().lower()
        models = filtered_models()
        num_pages = max(1, (len(models) + page_size - 1) // page_size)
        if not isinstance(page, int):
            page = 0

        if cmd in ("q", "quit"):
            console.print("[yellow]⚠ Cancelado.[/]")
            return
        elif cmd in ("f", "/", "filter", "filtrar"):
            filter_text = (Prompt.ask("  Filtro por nombre (Enter para limpiar)") or "").strip()
            page = 0
            page = render_page(page)
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
            page = render_page(page)


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
    summary = None
    if not model_info:
        console.print("[yellow]⚠ El modelo configurado no tiene endpoint HTTP directo para resumen de commits.[/]")
        if not Confirm.ask("  ¿Deseas continuar con el build sin resumen LLM?", default=True):
            console.print("[yellow]⚠ Build cancelado por el usuario.[/]")
            return
    else:
        console.print(f"[green]✓ Usando modelo: {model_info['provider']}/{model_info['model_id']}[/]")
        console.print("[dim]Generando resumen con LLM...[/]")
        summary = summarize_with_llm(upstream_commits, model_info)
        if not summary:
            console.print("[yellow]⚠ No se pudo obtener el resumen del LLM.[/]")
            if not Confirm.ask("  ¿Deseas continuar con el build sin resumen LLM?", default=True):
                console.print("[yellow]⚠ Build cancelado por el usuario.[/]")
                return

    # Display summary and ask for confirmation if generated
    if summary:
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


def show_recent_commits(repo_dir: Path, count: int = 5) -> None:
    """Display a clean summary table of the latest commits to verify local sync."""
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_dir), "log", f"-n{count}", "--pretty=format:%h%x09%ad%x09%an%x09%s", "--date=short"],
            capture_output=True,
            text=True,
            check=True,
        )
        lines = [line.strip() for line in res.stdout.strip().split("\n") if line.strip()]
        if not lines:
            return

        table = Table(
            title=f"📋 Últimos {len(lines)} Commits (HEAD)",
            border_style="cyan",
            header_style="bold cyan",
            box=box.ROUNDED,
            show_header=True,
        )
        table.add_column("Hash", style="yellow", no_wrap=True)
        table.add_column("Fecha", style="dim", no_wrap=True)
        table.add_column("Autor", style="green", no_wrap=True)
        table.add_column("Mensaje", style="white")

        for line in lines:
            parts = line.split("\t")
            if len(parts) >= 4:
                commit_hash, date, author, msg = parts[0], parts[1], parts[2], "\t".join(parts[3:])
                table.add_row(commit_hash, date, author, msg)
            elif len(parts) == 1:
                table.add_row(parts[0], "", "", "")

        console.print("")
        console.print(table)
        console.print("")
    except Exception as e:
        console.print(f"[dim]No se pudo obtener el historial de commits: {e}[/]")


def action_sync_fork() -> None:
    """Sync fork (origin) overwriting local changes with remote + install deps + build."""
    console.print("\n[bold]Sync de fork (origin) — sync + install + build...[/]")

    repo_dir = SCRIPT_DIR.parent
    try:
        subprocess.run(["git", "-C", str(repo_dir), "fetch", "origin"], capture_output=True)
        res_behind = subprocess.run(
            ["git", "-C", str(repo_dir), "rev-list", "--count", "HEAD..origin/dev"],
            capture_output=True,
            text=True,
        )
        res_ahead = subprocess.run(
            ["git", "-C", str(repo_dir), "rev-list", "--count", "origin/dev..HEAD"],
            capture_output=True,
            text=True,
        )
        res_status = subprocess.run(
            ["git", "-C", str(repo_dir), "status", "--porcelain", "--untracked-files=no"],
            capture_output=True,
            text=True,
        )
        behind_count = int(res_behind.stdout.strip() or "0")
        ahead_count = int(res_ahead.stdout.strip() or "0")
        has_tracked_changes = bool(res_status.stdout.strip())

        if behind_count == 0 and ahead_count == 0 and not has_tracked_changes:
            console.print("[green]⚡ \\[Fast-Exit] El fork ya está al día con origin/dev y sin cambios locales.[/]")
            show_recent_commits(repo_dir, 5)
            return
    except Exception:
        pass

    build_script = str(SCRIPT_DIR.parent / "build.sh")
    result = subprocess.run(["bash", build_script, "--sync-mode=fork"])
    if result.returncode != 0:
        console.print(f"[yellow]⚠ Build falló con código {result.returncode}[/]")
    else:
        console.print("[green]✓ Sync + build completado[/]")

    show_recent_commits(repo_dir, 5)


def action_compile_project() -> None:
    """Compile project (install deps + build, skipping git sync)."""
    console.print("\n[bold]Compilando el proyecto (build)...[/]")
    build_script = str(SCRIPT_DIR.parent / "build.sh")
    result = subprocess.run(["bash", build_script, "--skip-sync"])
    if result.returncode != 0:
        console.print(f"[yellow]⚠ Compilación falló con código {result.returncode}[/]")
    else:
        console.print("[green]✓ Compilación completada[/]")


def action_view_generated_config() -> None:
    """View the generated config."""
    if GENERATED_CONFIG.exists():
        with open(GENERATED_CONFIG) as f:
            content = f.read()
        console.print(Markdown(content))
    else:
        console.print("[yellow]No hay config generada aún.[/]")


def action_view_config() -> None:
    """Show the config submenu to view or compare configs."""
    show_config_menu()
    choice = Prompt.ask(
        "  ¿Qué deseas ver?",
        choices=["1", "2", "3", "0"],
        default="3",
    )
    if choice == "0":
        return
    elif choice == "1":
        action_view_generated_config()
    elif choice == "2":
        action_view_user_config()
    elif choice == "3":
        action_compare_configs()


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

def ensure_bun_version(target_ref: str = "upstream/dev") -> None:
    """Check if upstream requires a newer version of bun and perform cold upgrade before running tools or builds."""
    import shutil
    bun_bin = shutil.which("bun")
    if not bun_bin:
        return

    try:
        current_res = subprocess.run([bun_bin, "--version"], capture_output=True, text=True, timeout=5)
        current_bun = current_res.stdout.strip().lstrip("v")
        if not current_bun:
            return
    except Exception:
        return

    repo_dir = SCRIPT_DIR.parent
    try:
        pkg_res = subprocess.run(
            ["git", "-C", str(repo_dir), "show", f"{target_ref}:package.json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if pkg_res.returncode != 0:
            return
        pkg_data = json.loads(pkg_res.stdout)
        pkg_mgr = pkg_data.get("packageManager", "")
        # Format example: "bun@1.4.4"
        if not pkg_mgr.startswith("bun@"):
            return
        required_bun = pkg_mgr.split("bun@", 1)[1].strip()

        # Parse semver tuples for basic comparison
        def parse_v(v_str: str) -> list[int]:
            clean = v_str.split("-")[0].split("+")[0]
            parts = []
            for p in clean.split("."):
                if p.isdigit():
                    parts.append(int(p))
                else:
                    parts.append(0)
            return parts

        if parse_v(required_bun) > parse_v(current_bun):
            console.print(
                f"[yellow]⬆️  Upstream requiere Bun >= {required_bun} (instalado: {current_bun}). Actualizando Bun en frío antes de continuar...[/]"
            )
            brew_bin = shutil.which("brew")
            upgraded = False
            if brew_bin:
                brew_check = subprocess.run([brew_bin, "list", "bun"], capture_output=True, text=True)
                if brew_check.returncode == 0:
                    console.print("[dim]Ejecutando: brew upgrade bun[/]")
                    up_res = subprocess.run([brew_bin, "upgrade", "bun"])
                    upgraded = up_res.returncode == 0

            if not upgraded:
                console.print("[dim]Ejecutando: bun upgrade[/]")
                subprocess.run([bun_bin, "upgrade"])

            # Verify new version
            new_res = subprocess.run([bun_bin, "--version"], capture_output=True, text=True, timeout=5)
            new_bun = new_res.stdout.strip().lstrip("v")
            console.print(f"[green]✓ Bun listo: {new_bun}[/]")
    except Exception as e:
        console.print(f"[dim]Note: No se pudo verificar versión de Bun: {e}[/]")


def fetch_upstream_commits() -> Optional[str]:
    """Fetch upstream and return commits in upstream/dev not in HEAD."""
    try:
        repo_dir = SCRIPT_DIR.parent
        subprocess.run(
            ["git", "-C", str(repo_dir), "fetch", "upstream"],
            capture_output=True,
        )
        ensure_bun_version("upstream/dev")
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

    monitor = model_info.get("provider") == "llamacpp" and bool(derive_base_url(model_info.get("base_url", "")))
    if monitor:
        console.print(
            f"[dim]Payload: {payload_size} bytes | espera de carga: <= {llm_monitor.startup_wait_seconds()}s | "
            f"working: pregunta cada {llm_monitor.working_cap_seconds()}s | estado: /status (+ /metrics si es seguro)[/]"
        )
        return llm_monitor.run_llm_request(
            url,
            payload,
            model_info["model_id"],
            model_info["base_url"],
            max(timeout, llm_monitor.SOCKET_BACKSTOP),
            True,
        )

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

    console.print(f"[dim]Payload: {payload_size} bytes, Timeout: {timeout}s[/]")
    return llm_monitor.run_llm_request(
        url,
        payload,
        model_info["model_id"],
        model_info["base_url"],
        timeout,
        False,
    )


# ── main ─────────────────────────────────────────────────────────────────────

def print_cli_usage() -> None:
    """Print command-line usage matching RemoteDevcontainers conventions for local execution."""
    prog = Path(sys.argv[0]).name if sys.argv else "opencodeplus"
    console.print(
        Panel(
            Text("opencodeplus — Comandos de Inicio y Servicio Local", style="bold cyan", justify="center"),
            border_style="cyan",
        )
    )
    console.print(f"Uso: [bold]{prog}[/] \\[comando]\n")
    console.print("[bold cyan]Comandos de inicio y servicio local (estilo RemoteDevcontainers):[/]")
    console.print("  [bold]menu[/]             (Default sin argumentos) Abre el menú interactivo completo (1-12 o atajos t/w/p/s)")
    console.print("  [bold]web | open[/]       Asegura el servicio local, genera link de pair y abre el navegador")
    console.print("  [bold]pair | link[/]      Asegura el servicio local y muestra el link de un solo uso sin abrir navegador")
    console.print("  [bold]tui \\[args...][/]    Asegura el servicio local y conecta la TUI local (--server)")
    console.print("  [bold]start[/]            Inicia o asegura que el servicio local en segundo plano esté activo")
    console.print("  [bold]restart[/]          Reinicia el servicio local en segundo plano")
    console.print("  [bold]status[/]           Muestra el estado del servicio local, binario y salud de /api/info")
    console.print("  [bold]stop | down[/]      Detiene el servicio local en segundo plano")
    console.print("  [bold]help | --help[/]    Muestra esta ayuda\n")


def run_cli_command(args: list[str]) -> bool:
    """Handle direct CLI subcommands if passed. Returns True if a command was handled."""
    if not args:
        return False

    cmd = args[0].strip().lower()
    rest = args[1:]

    if cmd in ("menu", "interactive"):
        return False
    elif cmd in ("web", "open"):
        action_launch_web(open_browser=True)
        return True
    elif cmd in ("pair", "link"):
        action_launch_pair()
        return True
    elif cmd == "tui":
        action_launch_opencode(extra_args=rest)
        return True
    elif cmd == "start":
        ensure_local_service(force_restart=False)
        return True
    elif cmd in ("restart", "tunnel"):
        action_service_restart()
        return True
    elif cmd == "status":
        action_service_status()
        return True
    elif cmd in ("stop", "down"):
        action_service_stop()
        return True
    elif cmd in ("help", "-h", "--help"):
        print_cli_usage()
        return True
    else:
        console.print(f"[red]✗ Comando desconocido: {args[0]}[/]\n")
        print_cli_usage()
        sys.exit(1)


def show_main_menu() -> None:
    """Render the categorized main menu with explicit keys for Terminal (TUI), Web, Pair, and Service."""
    console.print(Rule())
    console.print(
        Panel(
            Text("Menú Principal", style="bold cyan", justify="center"),
            border_style="cyan",
            subtitle="Selecciona un número (1-12) o un atajo rápido (t, w, p, s)",
        )
    )

    console.print("  [bold cyan]🚀 Iniciar / Conectar OpenCode[/]")
    console.print("    [bold green]\\[1][/] [dim](\\[t])[/] [bold]Iniciar en Terminal (TUI)[/]   — Asegura el servicio local y conecta la TUI interactiva")
    console.print("    [bold green]\\[2][/] [dim](\\[w])[/] [bold]Iniciar OpenCode Web[/]        — Asegura el servicio, genera link pair y abre el navegador")
    console.print("    [bold green]\\[3][/] [dim](\\[p])[/] [bold]Generar Link Pair[/]           — Asegura el servicio y muestra el link (sin abrir navegador)")
    console.print("    [bold green]\\[4][/] [dim](\\[s])[/] [bold]Servicio Local (Daemon)[/]     — Estado detallado, start, restart, stop, web y pair")

    console.print("\n  [bold cyan]🤖 Modelos y Configuración[/]")
    console.print("    [bold cyan]\\[5][/]       Sync de Modelos             — Sincroniza modelos de LlamaCPP y LM Studio")
    console.print("    [bold cyan]\\[6][/]       Modelo por Defecto          — Selecciona el modelo activo por defecto")
    console.print("    [bold cyan]\\[7][/]       Ver / Comparar Config       — Visualiza y compara configs de modelos")
    console.print("    [bold cyan]\\[8][/]       Sync de PATH                — Gestiona la entrada de PATH en el shell")

    console.print("\n  [bold cyan]🔨 Build y Mantenimiento[/]")
    console.print("    [bold yellow]\\[9][/]       Build Completo (Upstream)   — Sync fork + upstream + instalar deps + compilar")
    console.print("    [bold yellow]\\[10][/]      Sync de Fork (Origin)       — Sync fork (origin) + instalar deps + compilar")
    console.print("    [bold yellow]\\[11][/]      Compilar Proyecto           — Instalar deps + compilar (sin sincronizar git)")
    console.print("    [bold yellow]\\[12][/]      Limpiar Temporales          — Escanea y limpia temporales según .gitignore")

    console.print("\n    [bold dim]\\[0][/] [dim](\\[q])[/] Salir")


def main(argv: Optional[list[str]] = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if run_cli_command(args):
        return

    show_welcome()

    valid_choices = [
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
        "t", "T", "tui", "TUI",
        "w", "W", "web", "WEB", "open", "OPEN",
        "p", "P", "pair", "PAIR", "link", "LINK",
        "s", "S", "service", "SERVICE", "daemon", "DAEMON",
        "q", "Q", "quit", "QUIT", "exit", "EXIT",
    ]

    while True:
        show_main_menu()

        choice = Prompt.ask(
            "\n  ¿Opción? [dim](1-12, t=Terminal, w=Web, p=Pair, s=Servicio, 0=Salir)[/]",
            choices=valid_choices,
            default="0",
            show_choices=False,
        ).strip().lower()

        if choice in ("0", "q", "quit", "exit"):
            console.print("\n[bold cyan]¡Hasta luego![/]\n")
            break
        elif choice in ("1", "t", "tui"):
            action_launch_opencode()
        elif choice in ("2", "w", "web", "open"):
            action_launch_web(open_browser=True)
        elif choice in ("3", "p", "pair", "link"):
            action_launch_pair()
        elif choice in ("4", "s", "service", "daemon"):
            action_manage_service()
        elif choice == "5":
            action_sync_models()
        elif choice == "6":
            action_select_model()
        elif choice == "7":
            action_view_config()
        elif choice == "8":
            action_sync_path()
        elif choice == "9":
            action_run_build()
        elif choice == "10":
            action_sync_fork()
        elif choice == "11":
            action_compile_project()
        elif choice == "12":
            prompt_temp_cleanup_on_startup()


if __name__ == "__main__":
    main()
