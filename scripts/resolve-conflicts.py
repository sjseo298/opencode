#!/usr/bin/env python3
"""
Resolve git stash/merge conflicts using the LLM.

After a stash pop or merge conflict, this script:
1. Detects conflicted files
2. Sends the conflict context to the LLM
3. Applies the LLM's resolution
4. Verifies resolution with typecheck and project compilation (build & smoke test)

Usage:
  python3 resolve-conflicts.py [--auto] [--compile] [--skip-compile] [--llm-timeout SECONDS]

Options:
  --auto          Skip confirmation before applying LLM resolution
  --compile       Force compilation and smoke test after resolution
  --skip-compile  Skip compilation check
  --llm-timeout   Override LLM timeout (default: 600)
"""

import json
import re
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

def get_conflict_markers(file_path: Path, repo_dir: Path) -> tuple[str, str, int, int]:
    """
    Get conflict information for a file.
    Returns (file_header, conflict_content, conflict_start, conflict_end)
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
        elif line.startswith(">>>>>>>") and conflict_start is not None:
            conflict_end = i
            break

    if conflict_start is None or conflict_end is None:
        # No conflict markers in the file (might have been resolved)
        return ("", "", -1, -1)

    # Get the conflict section with context
    context_before = 5
    context_after = 5
    start = max(0, conflict_start - context_before)
    end = min(len(lines), conflict_end + context_after + 1)

    conflict_section = "\n".join(lines[start:end])
    file_header = f"\n{'='*80}\n  FILE: {file_path.relative_to(repo_dir)}\n{'='*80}\n"

    return (file_header, conflict_section, conflict_start, conflict_end)

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
                "Eres un asistente experto en ingeniería de software y resolución de conflictos de merge de Git en TypeScript, Bun y Effect.\n"
                "Se te proporcionará una sección de código que contiene un conflicto delimitado por <<<<<<<, =======, y >>>>>>>.\n\n"
                "OBJETIVO:\n"
                "Producir ÚNICAMENTE el bloque de código resultante que reemplazará el conflicto, integrando armoniosamente los cambios.\n\n"
                "REGLAS CRÍTICAS:\n"
                "1. Devuelve SOLAMENTE el código resuelto correspondiente a la sección en conflicto.\n"
                "2. NO devuelvas el archivo entero.\n"
                "3. NUNCA incluyas bloques markdown (``` ni ```ts, etc.). Devuelve solo texto plano de código.\n"
                "4. NUNCA agregues comentarios explicativos antes o después del código.\n"
                "5. Elimina completamente todos los delimitadores de conflicto (<<<<<<<, =======, >>>>>>>).\n\n"
                "CRITERIOS DE INTEGRACIÓN TÉCNICA:\n"
                "1. COMPATIBILIDAD CON COMPILACIÓN: Tras aplicar tu código, el proyecto se compilará con `bun typecheck` y `build.ts`.\n"
                "   No introduzcas variables no declaradas, imports faltantes, ni rompas firmas o interfaces.\n"
                "2. FUSIÓN DE REFACTORIZACIONES Y CUSTOMIZACIONES:\n"
                "   - Si upstream refactoriza una lógica (ej. crea un helper o renombra parámetros) y el fork tiene personalizaciones (ej. timeouts de 2 horas o flags):\n"
                "     INTEGRA las personalizaciones del fork DENTRO de la nueva arquitectura de upstream.\n"
                "   - NO descartes ciegamente ni los cambios de upstream ni las personalizaciones del fork.\n"
                "3. CONSERVACIÓN DE EXPORTS:\n"
                "   - Si la sección en conflicto incluye exports (como export const, export function, export namespace), NUNCA los borres.\n"
                "4. BLOQUES ESPECÍFICOS DEL FORK:\n"
                "   - Los bloques marcados con:\n"
                "     // ── FORK: [nombre] ──\n"
                "     [código]\n"
                "     // ── END FORK ──\n"
                "     deben preservarse intactos y adaptarse a las variables actualizadas de upstream.\n"
                "5. Si la resolución es imposible sin romper el contrato del código, responde exactamente: <UNRESOLVABLE>"
            ),
        },
        {
            "role": "user",
            "content": f"{file_header}\n\nConflicto a resolver:\n{conflict_content}",
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

def fix_compilation_error_with_llm(
    file_path: Path,
    repo_dir: Path,
    error_msg: str,
    model_info: dict,
    timeout: int,
) -> bool:
    """Ask LLM to fix a compilation or typecheck error in the specified file."""
    url = f"{model_info['base_url']}/chat/completions"
    content = file_path.read_text()
    rel_path = file_path.relative_to(repo_dir)

    messages = [
        {
            "role": "system",
            "content": (
                "Eres un asistente experto en ingeniería de software y depuración en TypeScript, Bun y Effect.\n"
                "Se aplicó una resolución de conflicto de merge, pero la compilación/typecheck falló con un error.\n"
                "Debes proporcionar un reemplazo exacto (bloque old_str por new_str) para corregir el error en el archivo indicado.\n\n"
                "REGLAS:\n"
                "1. Devuelve ÚNICAMENTE un objeto JSON válido con las claves 'old_str' y 'new_str'.\n"
                "2. 'old_str' debe ser un fragmento de código que exista LITERALMENTE en el archivo.\n"
                "3. 'new_str' debe ser el código corregido que resuelve el error sin romper funcionalidades del fork ni de upstream.\n"
                "4. NUNCA agregues explicaciones fuera del JSON ni uses bloques markdown ```json.\n"
                'Ejemplo:\n{"old_str": "const timeout = 300_000", "new_str": "const timeout = 7_200_000"}'
            ),
        },
        {
            "role": "user",
            "content": (
                f"Archivo: {rel_path}\n\n"
                f"Error de compilación / typecheck:\n{error_msg}\n\n"
                f"Contenido del archivo (primeras 200 líneas):\n"
                + "\n".join(content.splitlines()[:200])
            ),
        },
    ]

    payload = json.dumps({
        "model": model_info["model_id"],
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 4096,
    }).encode("utf-8")

    monitor = model_info.get("provider") == "llamacpp" and bool(llm_monitor.derive_host_base(model_info.get("base_url", "")))
    socket_timeout = max(timeout, llm_monitor.SOCKET_BACKSTOP) if monitor else timeout
    raw_response = llm_monitor.run_llm_request(
        url,
        payload,
        model_info["model_id"],
        model_info["base_url"],
        socket_timeout,
        monitor,
    )

    if not raw_response:
        return False

    # Extract JSON
    try:
        data = json.loads(raw_response.strip())
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", raw_response)
        if match:
            try:
                data = json.loads(match.group(0))
            except json.JSONDecodeError:
                return False
        else:
            return False

    old_str = data.get("old_str")
    new_str = data.get("new_str")
    if not old_str or new_str is None:
        return False

    if old_str in content:
        content = content.replace(old_str, new_str, 1)
        file_path.write_text(content)
        console.print(f"[green]✓ Corrección automática aplicada en: {rel_path}[/]")
        return True

    return False

def apply_resolution(file_path: Path, repo_dir: Path, resolution: str, conflict_start: int, conflict_end: int) -> bool:
    """Apply the LLM's resolution to the conflict region in the file."""
    resolved = resolution.strip()

    if resolved.startswith("<UNRESOLVABLE>"):
        console.print(f"[yellow]⚠ Archivo no resoluble automáticamente: {file_path.relative_to(repo_dir)}[/]")
        return False

    # Strip code block wrappers if the LLM returned markdown
    if resolved.startswith("```"):
        lines = resolved.splitlines()
        # Drop opening ``` or ```language
        lines = lines[1:]
        # Drop closing ```
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        resolved = "\n".join(lines).strip()

    content = file_path.read_text()
    lines = content.splitlines(keepends=True)
    replacement = resolved + ("\n" if not resolved.endswith("\n") else "")
    new_content = "".join(lines[:conflict_start]) + replacement + "".join(lines[conflict_end + 1:])
    file_path.write_text(new_content)
    console.print(f"[green]✓ Resolución aplicada: {file_path.relative_to(repo_dir)}[/]")
    return True

def show_conflict_details(repo_dir: Path, files: list[str]) -> None:
    """Show details of all conflicts."""
    console.print(Panel("Conflictos detectados", border_style="red"))

    for file_name in files:
        file_path = repo_dir / file_name
        if not file_path.exists():
            continue

        header, content, _, _ = get_conflict_markers(file_path, repo_dir)
        if not content:
            continue

        console.print(f"\n  [dim]── {header} ──[/dim]")
        # Show a preview of the conflict
        lines = content.splitlines()
        preview_lines = [l for l in lines[:30] if l.startswith(("<<<<<<<", "=======", ">>>>>>"))]
        if preview_lines:
            console.print(f"  [dim]Conflicto en: {preview_lines[0]}[/dim]")

def get_affected_packages(file_paths: list[str]) -> set[str]:
    """Determine which package names under packages/ were affected."""
    packages = set()
    for f in file_paths:
        parts = Path(f).parts
        if len(parts) >= 2 and parts[0] == "packages":
            packages.add(parts[1])
    return packages

def has_code_files(file_paths: list[str]) -> bool:
    """Check if any of the affected files are code files."""
    code_exts = {".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"}
    return any(Path(f).suffix.lower() in code_exts for f in file_paths)

def run_typecheck(repo_dir: Path, packages: set[str]) -> tuple[bool, str, Optional[str]]:
    """Run bun typecheck for affected packages."""
    pkgs = packages if packages else {"opencode"}
    for pkg in pkgs:
        pkg_dir = repo_dir / "packages" / pkg
        if not pkg_dir.exists():
            continue
        console.print(f"[dim]  Verificando tipos en packages/{pkg} (bun typecheck)...[/dim]")
        res = run_cmd(["bun", "--cwd", str(pkg_dir), "typecheck"], cwd=repo_dir)
        if res.returncode != 0:
            err = (res.stderr or res.stdout).strip()
            return False, f"packages/{pkg} typecheck falló:\n{err}", pkg
    return True, "", None

def run_binary_build(repo_dir: Path) -> tuple[bool, str]:
    """Run single target build of opencode and smoke test."""
    pkg_dir = repo_dir / "packages" / "opencode"
    console.print("[dim]  Compilando binario de prueba (packages/opencode script/build.ts --single)...[/dim]")
    res = run_cmd(["bun", "--cwd", str(pkg_dir), "run", "script/build.ts", "--single"], cwd=repo_dir)
    if res.returncode != 0:
        err = (res.stderr or res.stdout).strip()
        lines = err.splitlines()
        tail = "\n".join(lines[-40:]) if len(lines) > 40 else err
        return False, tail
    return True, ""

def verify_resolution(
    repo_dir: Path,
    resolved_files: list[str],
    compile_binary: bool,
    model_info: dict,
    timeout: int,
) -> bool:
    """Verify that resolved files compile and pass typecheck, with auto-repair."""
    if not has_code_files(resolved_files):
        console.print("[green]✓ Los archivos resueltos no contienen código TypeScript/JavaScript; se omite compilación.[/]")
        return True

    console.print(Panel("Verificando compilación y tipos del proyecto", border_style="cyan"))
    affected_packages = get_affected_packages(resolved_files)

    # 1. Typecheck
    max_repair_attempts = 2
    typecheck_passed = False

    for attempt in range(max_repair_attempts + 1):
        ok, err_msg, failed_pkg = run_typecheck(repo_dir, affected_packages)
        if ok:
            typecheck_passed = True
            console.print("[green]✓ Typecheck superado exitosamente.[/]")
            break

        console.print(f"[yellow]⚠ Error de typecheck detectado (intento {attempt + 1}/{max_repair_attempts + 1}):[/]")
        console.print(f"[dim]{err_msg[:600]}[/dim]")

        if attempt < max_repair_attempts:
            target_file = None
            for rf in resolved_files:
                if Path(rf).name in err_msg or (failed_pkg and f"packages/{failed_pkg}" in rf):
                    target_file = repo_dir / rf
                    break
            if not target_file and resolved_files:
                target_file = repo_dir / resolved_files[0]

            if target_file and target_file.exists():
                console.print(f"[cyan]Intentando corrección automática con LLM en {target_file.relative_to(repo_dir)}...[/]")
                fixed = fix_compilation_error_with_llm(target_file, repo_dir, err_msg, model_info, timeout)
                if not fixed:
                    console.print("[yellow]⚠ El LLM no pudo proponer una corrección válida.[/]")
                    break
            else:
                break

    if not typecheck_passed:
        console.print(Panel("✗ La verificación de typecheck falló tras la resolución del conflicto.", border_style="red"))
        return False

    # 2. Binary Compilation
    if compile_binary:
        build_passed = False
        for attempt in range(max_repair_attempts + 1):
            ok, err_msg = run_binary_build(repo_dir)
            if ok:
                build_passed = True
                console.print("[green]✓ Compilación del binario y smoke test superados exitosamente.[/]")
                break

            console.print(f"[yellow]⚠ Error en compilación del binario (intento {attempt + 1}/{max_repair_attempts + 1}):[/]")
            console.print(f"[dim]{err_msg[:600]}[/dim]")

            if attempt < max_repair_attempts:
                target_file = None
                for rf in resolved_files:
                    if Path(rf).name in err_msg:
                        target_file = repo_dir / rf
                        break
                if not target_file and resolved_files:
                    target_file = repo_dir / resolved_files[0]

                if target_file and target_file.exists():
                    console.print(f"[cyan]Intentando corrección automática con LLM en {target_file.relative_to(repo_dir)}...[/]")
                    fixed = fix_compilation_error_with_llm(target_file, repo_dir, err_msg, model_info, timeout)
                    if not fixed:
                        console.print("[yellow]⚠ El LLM no pudo proponer una corrección válida.[/]")
                        break
                else:
                    break

        if not build_passed:
            console.print(Panel("✗ La compilación del binario falló tras la resolución del conflicto.", border_style="red"))
            return False

    return True

def ask_llm_for_resolution(repo_dir: Path, files: list[str], model_info: dict, timeout: int) -> tuple[bool, list[str]]:
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

        file_has_conflicts = False
        file_success = True

        while True:
            header, content, start_idx, end_idx = get_conflict_markers(file_path, repo_dir)
            if not content:
                break

            file_has_conflicts = True
            console.print(f"\n  [dim]── Resolviendo conflicto en: {file_name} ──[/dim]")
            resolution = resolve_conflict_with_llm(header, content, model_info, timeout)
            if llm_monitor.was_cancelled():
                failed_files.append(file_name)
                cancelled = True
                break

            if resolution and apply_resolution(file_path, repo_dir, resolution, start_idx, end_idx):
                continue
            else:
                file_success = False
                break

        if cancelled:
            break

        if file_has_conflicts:
            if file_success:
                resolved_files.append(file_name)
            else:
                failed_files.append(file_name)
        else:
            console.print(f"[green]✓ Sin marcadores de conflicto: {file_name}[/]")
            resolved_files.append(file_name)

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

    success = not cancelled and len(failed_files) == 0
    return success, resolved_files

def resolve_conflicts(
    repo_dir: Path,
    auto: bool = False,
    compile_binary: Optional[bool] = None,
    timeout: int = DEFAULT_LLM_TIMEOUT,
) -> int:
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
    success, resolved_files = ask_llm_for_resolution(repo_dir, files, model_info, timeout)
    if not success:
        return 1

    if resolved_files:
        # Determine whether to compile/test binary
        should_compile = compile_binary
        if should_compile is None:
            if auto:
                # In auto mode, compile if core/opencode packages were modified
                pkgs = get_affected_packages(resolved_files)
                should_compile = bool(pkgs.intersection({"opencode", "core"}))
            else:
                should_compile = Confirm.ask(
                    "\n  ¿Deseas compilar el proyecto (build & smoke test) para confirmar que la resolución funciona?",
                    default=True,
                )

        verified = verify_resolution(repo_dir, resolved_files, should_compile, model_info, timeout)
        if not verified:
            return 1

    return 0

def main() -> None:
    """Parse args and run resolution."""
    auto = "--auto" in sys.argv
    compile_binary = None
    if "--compile" in sys.argv:
        compile_binary = True
    elif "--skip-compile" in sys.argv or "--no-compile" in sys.argv:
        compile_binary = False

    timeout = DEFAULT_LLM_TIMEOUT

    for i, arg in enumerate(sys.argv):
        if arg == "--llm-timeout" and i + 1 < len(sys.argv):
            try:
                timeout = int(sys.argv[i + 1])
            except ValueError:
                console.print("[yellow]⚠ Timeout inválido, usando 600s[/]")
                timeout = DEFAULT_LLM_TIMEOUT

    repo_dir = SCRIPT_DIR.parent
    exit_code = resolve_conflicts(repo_dir, auto=auto, compile_binary=compile_binary, timeout=timeout)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
