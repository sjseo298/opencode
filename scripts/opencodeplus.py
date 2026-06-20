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

LLAMACPP_URL = "http://192.168.8.151:9999/v1/models"
LM_STUDIO_URL = "http://192.168.8.151:1234/api/v1/models"

# SCRIPT_DIR defaults to the scripts directory of this module;
# the wrapper overrides it when called from the opencodeplus script.
SCRIPT_DIR = Path(__file__).parent.resolve()
CONFIG_DIR = SCRIPT_DIR / "config"
GENERATED_CONFIG = CONFIG_DIR / "opencode.jsonc"

USER_CONFIG = Path.home() / ".config" / "opencode" / "opencode.jsonc"

DEFAULT_OUTPUT_LIMIT = 32768


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


def fmt_number(n: int) -> str:
    """Format number with thousands separators."""
    return f"{n:,}"


# ── model extraction ─────────────────────────────────────────────────────────

def extract_llamacpp_models(data: dict) -> dict:
    """Extract models from LlamaCPP API response."""
    models: dict = {}
    for item in data.get("data", []):
        model_id = item.get("id", "")
        if not model_id:
            continue

        preset_text = item.get("status", {}).get("preset", "")
        preset = parse_llamacpp_preset(preset_text)

        ctx_size = int(preset.get("ctx-size", 0))
        has_reasoning = "reasoning-budget" in preset
        has_agent = preset.get("agent") == "1"
        has_flash_attn = preset.get("flash-attn") == "true"
        has_kv_unified = preset.get("kv-unified") == "1"

        # Build name from preset alias or model id
        name = preset.get("alias", model_id)

        models[model_id] = {
            "api": "openai",
            "name": f"LlamaCPP - {name}",
            "options": {
                "baseURL": "http://192.168.8.151:9999/v1",
            },
            "models": {
                model_id: {
                    "id": model_id,
                    "name": f"LlamaCPP - {name}",
                    "tool_call": True,
                    "attachment": has_flash_attn,
                    "limit": {
                        "context": ctx_size if ctx_size > 0 else DEFAULT_OUTPUT_LIMIT,
                        "output": DEFAULT_OUTPUT_LIMIT,
                    },
                }
            },
        }
    return models


def extract_lmstudio_models(data: dict) -> dict:
    """Extract models from LM Studio native API response."""
    models: dict = {}
    for item in data.get("models", []):
        model_key = item.get("key", "")
        if not model_key:
            continue

        display_name = item.get("display_name", model_key)
        ctx_length = item.get("max_context_length", 0)
        capabilities = item.get("capabilities", {})
        has_vision = capabilities.get("vision", False)
        has_tool_use = capabilities.get("trained_for_tool_use", False)
        quantization = item.get("quantization", {})
        quant_name = quantization.get("name", "")

        # Build name with quantization info
        name = f"LM Studio - {display_name}"
        if quant_name:
            name += f"@{quant_name}"

        models[model_key] = {
            "api": "openai",
            "name": name,
            "options": {
                "baseURL": "http://192.168.8.151:1234/v1",
            },
            "models": {
                model_key: {
                    "id": model_key,
                    "name": name,
                    "tool_call": has_tool_use,
                    "attachment": has_vision,
                    "limit": {
                        "context": ctx_length if ctx_length > 0 else DEFAULT_OUTPUT_LIMIT,
                        "output": DEFAULT_OUTPUT_LIMIT,
                    },
                }
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
    table.add_column("Modelo", style="white")
    table.add_column("Contexto", justify="right")
    table.add_column("Output", justify="right")
    table.add_column("Herramientas")
    table.add_column("Adjuntos")

    for model_id, model_data in models.items():
        inner = model_data.get("models", {}).get(model_id, {})
        ctx = inner.get("limit", {}).get("context", 0)
        output = inner.get("limit", {}).get("output", 0)
        tool = "✓" if inner.get("tool_call") else ""
        attach = "✓" if inner.get("attachment") else ""

        table.add_row(
            model_id,
            fmt_number(ctx) if ctx else "—",
            fmt_number(output) if output else "—",
            tool,
            attach,
        )

    console.print(table)


# ── actions ──────────────────────────────────────────────────────────────────

def action_sync_model(server: str, url: str, extractor) -> None:
    """Sync models from a single server."""
    console.print(f"\n[bold]Consultando {server}...[/]")

    with Progress(SpinnerColumn(), TextColumn("[bold]Consultando {server}...[/]")) as progress:
        task = progress.add_task(f"Consultando {server}...", total=None)

        data = fetch_json(url)
        progress.update(task, completed=100)

        if not data:
            console.print(f"[red]✗ No se pudo conectar a {server}[/]")
            return

        models = extractor(data)
        if not models:
            console.print("[yellow]⚠ No se encontraron modelos[/]")
            return

        console.print(f"[green]✓ {len(models)} modelos encontrados[/]")
        display_model_table(models, server)

        # Generate and compare config
        all_models = extract_models_from_servers(server)
        new_config = generate_config(
            all_models.get("llamacpp", {}),
            all_models.get("lmstudio", {}),
        )

        if config_has_changes(new_config, load_user_config()):
            if Confirm.ask("¿Actualizar config del usuario?"):
                if update_user_config(new_config):
                    console.print("[green]✓ Config actualizada[/]")
                    write_config_to_file(new_config, GENERATED_CONFIG)
                    if git_commit(f"chore: sync {server} models ({len(models)} models)"):
                        console.print("[green]✓ Commit hecho[/]")
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
            llamacpp = extract_llamacpp_models(data)
            console.print(f"[green]  LlamaCPP: {len(llamacpp)} modelos[/]")

    if server in ("lmstudio", "both"):
        data = fetch_json(LM_STUDIO_URL)
        if data:
            lmstudio = extract_lmstudio_models(data)
            console.print(f"[green]  LM Studio: {len(lmstudio)} modelos[/]")

    return {"llamacpp": llamacpp, "lmstudio": lmstudio}


def action_sync_models() -> None:
    """Sync models from selected server(s)."""
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
        table.add_column("Modelo", style="white")
        table.add_column("Contexto", justify="right")
        table.add_column("Output", justify="right")
        table.add_column("Herramientas")
        table.add_column("Adjuntos")

        for model_id, model_data in llamacpp.items():
            inner = model_data.get("models", {}).get(model_id, {})
            ctx = inner.get("limit", {}).get("context", 0)
            output = inner.get("limit", {}).get("output", 0)
            table.add_row(
                "LlamaCPP",
                model_id,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                "✓" if inner.get("attachment") else "",
            )

        for model_id, model_data in lmstudio.items():
            inner = model_data.get("models", {}).get(model_id, {})
            ctx = inner.get("limit", {}).get("context", 0)
            output = inner.get("limit", {}).get("output", 0)
            table.add_row(
                "LM Studio",
                model_id,
                fmt_number(ctx) if ctx else "—",
                fmt_number(output) if output else "—",
                "✓" if inner.get("tool_call") else "",
                "✓" if inner.get("attachment") else "",
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
                    if git_commit(f"chore: sync both servers ({total} models)"):
                        console.print("[green]✓ Commit hecho[/]")
                else:
                    console.print("[yellow]⚠ No hubo cambios[/]")
            else:
                console.print("[yellow]⚠ Cancelado[/]")
        else:
            console.print("[green]✓ La config ya está actualizada[/]")
    else:
        action_sync_model(server, url, extractor)


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


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    show_welcome()

    menu_items = {
        "1": ("Sync de Modelos", action_sync_models),
        "2": ("Sync de PATH", action_sync_path),
        "3": ("Ver Config", lambda: (show_config_menu(),)),
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
        console.print("  [1] Sync de Modelos — Sincroniza modelos de LlamaCPP y LM Studio")
        console.print("  [2] Sync de PATH    — Gestiona la entrada de PATH en el shell")
        console.print("  [3] Ver Config      — Visualiza y compara configs de modelos")
        console.print("  [0] Salir")

        choice = Prompt.ask("\n  ¿Opción?", choices=["0", "1", "2", "3"], default="0")

        if choice == "0":
            console.print("\n[bold cyan]¡Hasta luego![/]\n")
            break
        elif choice == "1":
            action_sync_models()
        elif choice == "2":
            action_sync_path()
        elif choice == "3":
            action_view_config()


if __name__ == "__main__":
    main()
