#!/usr/bin/env python3
"""
Resolve git stash/merge conflicts using the LLM.

After a stash pop or merge conflict, this script:
1. Detects conflicted files
2. Sends the conflict context to the LLM
3. Applies the LLM's resolution

Usage:
  python3 resolve-conflicts.py [--auto] [--llm-timeout SECONDS]

Options:
  --auto         Skip confirmation before applying LLM resolution
  --llm-timeout  Override LLM timeout (default: 600)
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import llm_monitor

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Confirm
except ImportError:
    print("\n[red]✗[/] rich no está instalada.\n\n"
          "Instálala con:\n"
          "    pip install rich\n")
    sys.exit(1)

console = Console()

# ── defaults ─────────────────────────────────────────────────────────────────

DEFAULT_LLM_TIMEOUT = 600  # 10 minutes
USER_CONFIG = Path.home() / ".config" / "opencode" / "opencode.jsonc"

# ── helpers ──────────────────────────────────────────────────────────────────

def run_cmd(cmd: list[str], cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    """Run a command and return the result."""
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)

def get_conflicted_files(repo_dir: Path) -> list[str]:
    """Get list of files with conflicts (both merge and stash conflicts)."""
    result = run_cmd(["git", "diff", "--name-only", "--diff-filter=U"], cwd=repo_dir)
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip().splitlines()
    return []

def get_conflict_markers(file_path: Path, repo_dir: Path) -> tuple[str, str]:
    """
    Get conflict information for a file.
    Returns (file_header, conflict_content)
    """
    # Get the conflict markers from the file
    content = file_path.read_text()
    lines = content.splitlines()

    # Find conflict markers
    conflict_start = None
    conflict_end = None
    for i, line in enumerate(lines):
        if line.startswith("<<<<<<<"):
            conflict_start = i
        elif line.startswith("=======") and conflict_start is not None:
            separator_line = i
        elif line.startswith(">>>>>>>") and conflict_start is not None:
            conflict_end = i

    if conflict_start is None:
        # No conflict markers in the file (might have been resolved)
        return ("", "")

    # Get the conflict section with context
    context_before = 5
    context_after = 5
    start = max(0, conflict_start - context_before)
    end = min(len(lines), conflict_end + context_after + 1)

    conflict_section = "\n".join(lines[start:end])
    file_header = f"\n{'='*80}\n  FILE: {file_path.relative_to(repo_dir)}\n{'='*80}\n"

    return (file_header, conflict_section)

def get_default_model_from_config() -> Optional[dict]:
    """Read the default model from the user config."""
    if not USER_CONFIG.exists():
        return None
    try:
        config = json.loads(USER_CONFIG.read_text())
    except (json.JSONDecodeError, OSError):
        return None

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

    return {
        "provider": provider_name,
        "model_id": model_id,
        "base_url": base_url,
    }

def resolve_conflict_with_llm(file_header: str, conflict_content: str, model_info: dict, timeout: int) -> Optional[str]:
    """Send conflict context to LLM and return the resolution."""
    url = f"{model_info['base_url']}/chat/completions"

    messages = [
        {
            "role": "system",
            "content": (
                "Eres un asistente experto en resolución de conflictos de git. "
                "Debes analizar el conflicto y proporcionar una resolución clara y correcta.\n\n"
                "REGLAS:\n"
                "1. Debes devolver SOLO el contenido del archivo resuelto, SIN marcadores de conflicto.\n"
                "2. NO incluyas marcas de inicio o fin como ``` o ```\n"
                "3. No incluyas explicaciones, comentarios ni texto adicional.\n"
                "4. Si el conflicto tiene dos opciones claras (ours y theirs), elige la mejor opción\n"
                "   o combina ambas según el contexto.\n"
                "5. Si no puedes resolver el conflicto, responde con: <UNRESOLVABLE>\n"
                "6. Responde en español.\n\n"
                "BLOQUES FORK:\n"
                "Este repositorio tiene bloques de código específicos del fork marcados con:\n"
                "  // ── FORK: [nombre] ──\n"
                "  [código]\n"
                "  // ── END FORK ──\n\n"
                "Cuando resuelvas conflictos:\n"
                "1. SIEMPRE preserva estos bloques FORK intactos.\n"
                "2. Sigue las instrucciones MERGE INSTRUCTIONS en los comentarios del bloque.\n"
                "3. Si upstream cambió nombres de variables (ej: cfg -> config), actualiza\n"
                "   el bloque FORK para usar los nuevos nombres.\n"
                "4. Mantén el bloque en la misma posición lógica relativa al código circundante."
            ),
        },
        {
            "role": "user",
            "content": f"{file_header}\n\n{conflict_content}",
        },
    ]

    payload = json.dumps({
        "model": model_info["model_id"],
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 8192,
    }).encode("utf-8")

    monitor = model_info.get("provider") == "llamacpp" and bool(llm_monitor.derive_host_base(model_info.get("base_url", "")))
    socket_timeout = max(timeout, llm_monitor.SOCKET_BACKSTOP) if monitor else timeout
    return llm_monitor.run_llm_request(
        url,
        payload,
        model_info["model_id"],
        model_info["base_url"],
        socket_timeout,
        monitor,
    )

def apply_resolution(file_path: Path, repo_dir: Path, resolution: str) -> bool:
    """Apply the LLM's resolution to the file."""
    resolved = resolution.strip()

    if resolved.startswith("<UNRESOLVABLE>"):
        console.print(f"[yellow]⚠ Archivo no resoluble automáticamente: {file_path.relative_to(repo_dir)}[/]")
        return False

    # Write the resolved content
    file_path.write_text(resolved)
    console.print(f"[green]✓ Resolución aplicada: {file_path.relative_to(repo_dir)}[/]")
    return True

def show_conflict_details(repo_dir: Path, files: list[str]) -> None:
    """Show details of all conflicts."""
    console.print(Panel("Conflictos detectados", border_style="red"))

    for file_name in files:
        file_path = repo_dir / file_name
        if not file_path.exists():
            continue

        header, content = get_conflict_markers(file_path, repo_dir)
        if not content:
            continue

        console.print(f"\n  [dim]── {header} ──[/dim]")
        # Show a preview of the conflict
        lines = content.splitlines()
        preview_lines = [l for l in lines[:30] if l.startswith(("<<<<<<<", "=======", ">>>>>>"))]
        if preview_lines:
            console.print(f"  [dim]Conflicto en: {preview_lines[0]}[/dim]")

def ask_llm_for_resolution(repo_dir: Path, files: list[str], model_info: dict, timeout: int) -> bool:
    """Ask LLM to resolve each conflict and apply the resolution."""
    console.print(Panel("Resolviendo conflictos con LLM", border_style="cyan"))

    resolved_files = []
    failed_files = []
    cancelled = False
    processed = 0

    for file_name in files:
        processed += 1
        file_path = repo_dir / file_name
        if not file_path.exists():
            failed_files.append(file_name)
            continue

        header, content = get_conflict_markers(file_path, repo_dir)
        if not content:
            # No conflict markers, try to resolve anyway
            console.print(f"[green]✓ Sin marcadores de conflicto: {file_name}[/]")
            resolved_files.append(file_name)
            continue

        console.print(f"\n  [dim]── Resolviendo: {file_name} ──[/dim]")
        resolution = resolve_conflict_with_llm(header, content, model_info, timeout)
        if llm_monitor.was_cancelled():
            failed_files.append(file_name)
            cancelled = True
            break

        if resolution:
            if apply_resolution(file_path, repo_dir, resolution):
                resolved_files.append(file_name)
            else:
                failed_files.append(file_name)
        else:
            failed_files.append(file_name)

    # Summary
    console.print("\n[bold]Resumen:[/bold]")
    if resolved_files:
        console.print(f"[green]✓ Resueltos: {len(resolved_files)} archivo(s)[/]")
        for f in resolved_files:
            console.print(f"  {f}")
    if failed_files:
        console.print(f"\n[yellow]✗ No resueltos: {len(failed_files)} archivo(s)[/]")
        for f in failed_files:
            console.print(f"  {f}")
    if cancelled:
        pending = len(files) - processed
        if pending > 0:
            console.print(f"\n[yellow]⚠ Cancelado por el usuario. Pendientes: {pending} archivo(s).[/]")
        else:
            console.print("\n[yellow]⚠ Cancelado por el usuario.[/]")
    return cancelled

def resolve_conflicts(repo_dir: Path, auto: bool = False, timeout: int = DEFAULT_LLM_TIMEOUT) -> int:
    """Main resolution logic. Returns 0 on success, 1 on failure."""
    console.print(Panel("Resolución de conflictos con LLM", border_style="cyan"))

    # Check for LLM model
    model_info = get_default_model_from_config()
    if not model_info:
        console.print("[yellow]⚠ No se encontró modelo por defecto en la config.[/]")
        console.print("  Configuración en: ~/.config/opencode/opencode.jsonc")
        console.print("  Formato esperado: \"model\": \"provider/model_id\"")
        return 1

    console.print(f"[green]✓ Usando modelo: {model_info['provider']}/{model_info['model_id']}[/]")
    if model_info.get("provider") == "llamacpp":
        console.print(
            f"[green]✓ Modo monitoreado: /status (+ /metrics si es seguro) (pregunta de cancelación cada {llm_monitor.working_cap_seconds()}s)[/]\n"
        )
    else:
        console.print(f"[green]✓ Timeout: {timeout}s[/]\n")

    # Get conflicted files
    files = get_conflicted_files(repo_dir)
    if not files:
        console.print("[green]✓ No hay conflictos detectados.[/]")
        return 0

    console.print(f"[yellow]⚠ {len(files)} archivo(s) con conflictos:[/]")
    for f in files:
        console.print(f"  {f}")
    console.print()

    # Show details
    show_conflict_details(repo_dir, files)

    # Confirm resolution
    if not auto:
        if not Confirm.ask("\n  ¿Resolver conflictos con el LLM?", default=True):
            console.print("[yellow]Cancelado[/]")
            return 1

    # Resolve with LLM
    cancelled = ask_llm_for_resolution(repo_dir, files, model_info, timeout)
    if cancelled:
        return 1

    return 0

def main() -> None:
    """Parse args and run resolution."""
    auto = "--auto" in sys.argv
    timeout = DEFAULT_LLM_TIMEOUT

    for i, arg in enumerate(sys.argv):
        if arg == "--llm-timeout" and i + 1 < len(sys.argv):
            try:
                timeout = int(sys.argv[i + 1])
            except ValueError:
                console.print("[yellow]⚠ Timeout inválido, usando 600s[/]")
                timeout = DEFAULT_LLM_TIMEOUT

    repo_dir = SCRIPT_DIR.parent
    exit_code = resolve_conflicts(repo_dir, auto=auto, timeout=timeout)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
