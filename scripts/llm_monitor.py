#!/usr/bin/env python3
"""
llm_monitor — Monitoreo de estado del servidor LLM durante peticiones.

Usa los endpoints /status y /metrics del servidor (llama.cpp o proxy) para
saber si el modelo pedido está cargado y si el servidor está procesando:

  /status   -> model.active_id, slots (state / prefill.active / inference.active)
  /metrics  -> llamacpp:requests_processing, llamacpp:requests_deferred

Comportamiento:
  - Servidor inaccesible o modelo cargando: cuenta atrás de
    OPENCODEPLUS_MODEL_READY_TIMEOUT segundos (default 900).
  - Servidor procesando (working): sin timeout fijo; se espera a que termine.
    Al alcanzar OPENCODEPLUS_WORKING_TIMEOUT segundos (default 1800, 30 min)
    se pregunta al usuario si cancelar o seguir esperando (se repite cada
    30 min mientras siga working).
  - Modelo cargado y servidor idle sin respuesta durante IDLE_GRACE: la
    petición se considera perdida y se reintenta.

Variables de entorno:
  OPENCODEPLUS_MODEL_READY_TIMEOUT  (default 900)
  OPENCODEPLUS_WORKING_TIMEOUT      (default 1800)
"""

import json
import os
import re
import threading
import time
import urllib.request
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from rich.console import Console
from rich.prompt import Confirm

console = Console()

DEFAULT_STARTUP_WAIT = 900    # segundos esperando carga del modelo
DEFAULT_WORKING_CAP = 1800    # 30 min de working continuo antes de preguntar
IDLE_GRACE = 180              # servidor idle sin respuesta => petición perdida
POLL_INTERVAL = 5             # segundos entre sondeos de estado
SOCKET_BACKSTOP = 21600       # timeout de socket de respaldo (6 h)
WARMUP_RETRY_INTERVAL = 20    # segundos entre warmups cuando el modelo no está cargado
RETRYABLE_HTTP = {408, 409, 425, 429, 500, 502, 503, 504}
WORKING_SLOT_STATES = {"busy", "processing", "active", "loading"}

_cancelled = False
_metrics_blocked_cache: dict[str, bool] = {}


def startup_wait_seconds() -> int:
    return max(120, _pos_int(os.environ.get("OPENCODEPLUS_MODEL_READY_TIMEOUT"), DEFAULT_STARTUP_WAIT))


def working_cap_seconds() -> int:
    return max(60, _pos_int(os.environ.get("OPENCODEPLUS_WORKING_TIMEOUT"), DEFAULT_WORKING_CAP))


def was_cancelled() -> bool:
    return _cancelled


def reset_cancelled() -> None:
    global _cancelled
    _cancelled = False


def _mark_cancelled() -> None:
    global _cancelled
    _cancelled = True


def _cache_metrics_policy(base: str, blocked: bool) -> None:
    if base:
        _metrics_blocked_cache[base] = bool(blocked)


def _is_metrics_blocked(base: str) -> bool:
    return bool(_metrics_blocked_cache.get(base, False))


def _pos_int(value: object, default: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def derive_host_base(url: str) -> str:
    """Return scheme://host[:port] from a URL like http://host:9999/v1."""
    p = urlsplit(url)
    if not p.scheme or not p.netloc:
        return ""
    return f"{p.scheme}://{p.netloc}"


def get_llamacpp_server_state(base: str) -> dict:
    """Fetch /status + /metrics from a llama.cpp-compatible server (5s timeout each)."""
    out = {
        "status_ok": False,
        "metrics_ok": False,
        "server_name": "",
        "server_mode": "",
        "server_state": "",
        "active_id": "",
        "active_alias": "",
        "active_display_name": "",
        "processing": 0,
        "deferred": 0,
        "slots_busy": False,
        "metrics_blocked": _is_metrics_blocked(base),
    }

    try:
        req = urllib.request.Request(f"{base}/status")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        if isinstance(data, dict):
            out["status_ok"] = True
            server = data.get("server") or {}
            out["server_name"] = server.get("name", "") or ""
            out["server_mode"] = server.get("mode", "") or ""
            out["server_state"] = server.get("state", "") or ""
            model = data.get("model") or {}
            out["active_id"] = model.get("active_id", "") or ""
            out["active_alias"] = model.get("active_alias", "") or ""
            out["active_display_name"] = model.get("active_display_name", "") or ""
            slots = (data.get("slots") or {}).get("items") or []
            out["slots_busy"] = any(
                s.get("state") in WORKING_SLOT_STATES
                or bool((s.get("prefill") or {}).get("active"))
                or bool((s.get("inference") or {}).get("active"))
                for s in slots
                if isinstance(s, dict)
            )
    except (HTTPError, URLError, OSError, json.JSONDecodeError):
        pass

    if out["status_ok"]:
        smart_proxy = str(out["server_name"] or "").strip().lower() == "smart-model-proxy"
        out["metrics_blocked"] = smart_proxy
        _cache_metrics_policy(base, smart_proxy)
        if smart_proxy:
            return out
    elif out["metrics_blocked"]:
        return out
    else:
        try:
            req = urllib.request.Request(f"{base}/health")
            with urllib.request.urlopen(req, timeout=3) as resp:
                body = json.loads(resp.read().decode())
            if isinstance(body, dict):
                server = body.get("server") or {}
                server_name = str(server.get("name") or "").strip().lower()
                if server_name == "smart-model-proxy":
                    out["server_name"] = server.get("name", "") or out["server_name"]
                    out["server_mode"] = server.get("mode", "") or out["server_mode"]
                    out["server_state"] = server.get("state", "") or out["server_state"]
                    out["metrics_blocked"] = True
                    _cache_metrics_policy(base, True)
                    return out
                if server_name:
                    _cache_metrics_policy(base, False)
        except (HTTPError, URLError, OSError, json.JSONDecodeError):
            pass

    try:
        req = urllib.request.Request(f"{base}/metrics")
        with urllib.request.urlopen(req, timeout=5) as resp:
            text = resp.read().decode()
        out["metrics_ok"] = True
        for metric, key in (
            ("llamacpp:requests_processing", "processing"),
            ("llamacpp:requests_deferred", "deferred"),
        ):
            m = re.search(rf"^{re.escape(metric)}[ \t]+([0-9.eE+-]+)", text, re.MULTILINE)
            if m:
                try:
                    out[key] = int(float(m.group(1)))
                except ValueError:
                    pass
    except (HTTPError, URLError, OSError):
        pass

    return out


def is_model_loaded(state: dict, model_id: str) -> bool:
    """True if the requested model is the active one on the server."""
    if not model_id or not state.get("status_ok"):
        return True
    if str(state.get("server_name", "")).strip().lower() == "smart-model-proxy":
        if str(state.get("server_state", "")).strip().lower() == "loading":
            return False
    target = _normalize_model_id(model_id)
    if target.startswith("llamacpp-"):
        target = target.removeprefix("llamacpp-")
    candidates = {
        state.get("active_id", ""),
        state.get("active_alias", ""),
        state.get("active_display_name", ""),
    }
    for candidate in candidates:
        if not candidate:
            continue
        if _normalize_model_id(candidate) == target:
            return True
    return False


def _normalize_model_id(value: str) -> str:
    """Normalize model id for resilient comparisons across alias/display variants."""
    text = (value or "").strip().lower()
    if not text:
        return ""
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def _state_is_working(state: dict) -> bool:
    """Derive working state from status/metrics without side effects."""
    status_working = bool(state.get("slots_busy"))
    server_state = str(state.get("server_state") or "").strip().lower()
    if server_state in ("loading", "switch_loading", "switch_starting", "switch_stopping", "switch_waiting_memory"):
        status_working = True
    metrics_working = int(state.get("processing") or 0) + int(state.get("deferred") or 0) > 0
    return status_working or metrics_working


def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def _ask_cancel(elapsed: float, cap: int) -> bool:
    try:
        return bool(
            Confirm.ask(
                f"\n[yellow]El servidor lleva {_fmt_duration(elapsed)} procesando "
                f"(límite: {_fmt_duration(cap)}). ¿Cancelar o seguir esperando?[/]",
                default=False,
            )
        )
    except EOFError:
        return False


def _abort_response(box: dict) -> None:
    resp = box.get("resp")
    if resp is None:
        return
    try:
        resp.close()
    except Exception:
        pass


def _send_sync(url: str, payload: bytes, socket_timeout: int) -> tuple:
    """Single blocking request. Returns (status, value)."""
    try:
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=socket_timeout) as resp:
            data = json.loads(resp.read().decode())
        choices = data.get("choices") or []
        if choices:
            content = (choices[0].get("message") or {}).get("content")
            if content:
                return ("ok", content)
        return ("fatal", "respuesta del LLM sin contenido")
    except HTTPError as e:
        return (("fatal" if e.code not in RETRYABLE_HTTP else "retry"), f"HTTP {e.code}")
    except json.JSONDecodeError as e:
        return ("retry", f"respuesta inválida: {e}")
    except (URLError, TimeoutError, OSError) as e:
        return ("retry", str(e) or e.__class__.__name__)
    except Exception as e:
        return ("fatal", str(e) or e.__class__.__name__)


def _send_worker(url: str, payload: bytes, socket_timeout: int, box: dict, done: threading.Event) -> None:
    """Background worker: sends the request and stores the outcome in `box`."""
    try:
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=socket_timeout) as resp:
            box["resp"] = resp
            data = json.loads(resp.read().decode())
        choices = data.get("choices") or []
        if choices:
            content = (choices[0].get("message") or {}).get("content")
            if content:
                box["ok"] = content
        if "ok" not in box:
            box["error"] = "respuesta del LLM sin contenido"
            box["fatal"] = True
    except HTTPError as e:
        box["error"] = f"HTTP {e.code}"
        box["fatal"] = e.code not in RETRYABLE_HTTP
    except json.JSONDecodeError as e:
        box["error"] = f"respuesta inválida: {e}"
    except (URLError, TimeoutError, OSError) as e:
        box["error"] = str(e) or e.__class__.__name__
    except Exception as e:
        box["error"] = str(e) or e.__class__.__name__
        box["fatal"] = True
    finally:
        done.set()


def _start_warmup_request(url: str, model_id: str, timeout: int) -> None:
    """Fire a lightweight request to trigger model load before monitoring loops."""
    payload = json.dumps({
        "model": model_id,
        "messages": [{"role": "user", "content": "Responde solo: ok"}],
        "temperature": 0,
        "max_tokens": 8,
    }).encode("utf-8")

    def worker() -> None:
        try:
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()
        except Exception:
            pass

    threading.Thread(target=worker, daemon=True).start()


def _collect(box: dict) -> tuple:
    if box.get("ok"):
        return ("ok", box["ok"])
    return (("fatal" if box.get("fatal") else "retry"), box.get("error", "error desconocido"))


def send_monitored(
    url: str,
    payload: bytes,
    model_id: str,
    base: str,
    socket_timeout: int,
    load_deadline: float,
    monitor: bool,
) -> tuple:
    """Send a chat completion request, monitoring server state while waiting.

    Returns (status, value): ("ok", content) | ("retry" | "fatal", reason) | ("cancel", None).
    With monitor=True the request is sent in a background thread and /status + /metrics
    are polled: loading/unreachable time is bounded by load_deadline, working time is
    not (with a user confirmation prompt at working_cap_seconds()).
    """
    if not monitor:
        return _send_sync(url, payload, socket_timeout)

    cap = working_cap_seconds()
    load_wait = startup_wait_seconds()
    box: dict = {}
    done = threading.Event()
    thread: Optional[threading.Thread] = None
    sent = False
    working_since: Optional[float] = None
    idle_since: Optional[float] = None
    last_print = 0.0
    printed_progress = False
    next_send_at = 0.0
    metrics_blocked_notified = False
    next_warmup_at = 0.0

    def phase_print(line: str, force: bool = False) -> None:
        nonlocal last_print, printed_progress
        now = time.monotonic()
        if force or not printed_progress or now - last_print >= 15:
            console.print(f"[dim]{line}[/]")
            last_print = now
            printed_progress = True

    while True:
        now = time.monotonic()
        state = get_llamacpp_server_state(base)
        state_ok = state["status_ok"] or state["metrics_ok"]
        working = _state_is_working(state)
        loaded = is_model_loaded(state, model_id)

        if sent and done.is_set():
            if thread is not None:
                thread.join(timeout=10)
            status, value = _collect(box)
            if status in ("ok", "fatal"):
                return status, value
            remaining = int(load_deadline - now)
            if remaining <= 0 and not working:
                return ("fatal", f"el servidor no pudo estabilizarse tras {load_wait}s (último error: {value})")
            if not state_ok:
                console.print(f"[yellow]⚠ LLM API error: {value}; reintentando mientras el servidor vuelve a responder...[/]")
            elif not loaded:
                console.print(f"[yellow]⚠ LLM API error: {value}; reintentando mientras el modelo termina de cargar...[/]")
            elif working:
                console.print(f"[yellow]⚠ LLM API error: {value}; reintentando cuando el servidor se libere...[/]")
            else:
                console.print(f"[yellow]⚠ LLM API error: {value}; reintentando...[/]")
            box = {}
            done = threading.Event()
            sent = False
            next_send_at = now + 6
            if not loaded:
                next_warmup_at = now
            continue

        if not sent:
            if not state_ok:
                remaining = int(load_deadline - now)
                if remaining <= 0:
                    return ("fatal", f"el servidor no respondió y el modelo no cargó tras {load_wait}s")
                phase_print(f"Esperando el servidor... ({remaining}s restantes)")
                time.sleep(min(POLL_INTERVAL, max(1, remaining)))
                continue

            if state.get("metrics_blocked") and not metrics_blocked_notified:
                phase_print("Servidor smart-model-proxy detectado: usando solo /status para evitar cambios de modelo.", force=True)
                metrics_blocked_notified = True

            if working:
                idle_since = None
                if working_since is None:
                    working_since = now
                    console.print("[dim]El servidor está procesando; esperando a que termine (sin timeout)...[/]")
                elif now - last_print >= 15:
                    phase_print(f"El servidor está procesando; esperando a que termine... ({_fmt_duration(now - working_since)})", force=True)
                if now - working_since >= cap:
                    if _ask_cancel(now - working_since, cap):
                        _mark_cancelled()
                        return ("cancel", None)
                    working_since = now
                time.sleep(POLL_INTERVAL)
                continue

            if not loaded:
                if now >= next_warmup_at:
                    phase_print(f"Forzando carga del modelo seleccionado: {model_id}", force=True)
                    _start_warmup_request(url, model_id, max(120, load_wait))
                    next_warmup_at = now + WARMUP_RETRY_INTERVAL
                remaining = int(load_deadline - now)
                if remaining <= 0:
                    return ("fatal", f"el modelo no terminó de cargar tras {load_wait}s")
                phase_print(f"Cargando modelo remoto... ({remaining}s restantes)")
                time.sleep(min(POLL_INTERVAL, max(1, remaining)))
                continue

            if now < next_send_at:
                wait_seconds = int(next_send_at - now)
                if wait_seconds > 0:
                    phase_print(f"Reintentando petición en {wait_seconds}s...")
                time.sleep(min(POLL_INTERVAL, max(1, wait_seconds)))
                continue

            working_since = None
            idle_since = None
            box = {}
            done = threading.Event()
            thread = threading.Thread(
                target=_send_worker,
                args=(url, payload, socket_timeout, box, done),
                daemon=True,
            )
            thread.start()
            sent = True
            next_send_at = 0.0
            console.print(f"[dim]Petición principal enviada (modelo: {model_id}); monitoreando /status y /metrics...[/]")
            continue

        if not state_ok:
            remaining = int(load_deadline - now)
            if remaining <= 0:
                return ("fatal", f"el servidor se volvió inaccesible y el modelo no cargó tras {load_wait}s")
            phase_print(f"Esperando el servidor... ({remaining}s restantes)")
            time.sleep(min(POLL_INTERVAL, max(1, remaining)))
            continue

        if working:
            idle_since = None
            if working_since is None:
                working_since = now
                console.print("[dim]El servidor está procesando; esperando a que termine (sin timeout)...[/]")
            elif now - last_print >= 15:
                phase_print(f"El servidor está procesando; esperando a que termine... ({_fmt_duration(now - working_since)})", force=True)
            if now - working_since >= cap:
                if _ask_cancel(now - working_since, cap):
                    _abort_response(box)
                    _mark_cancelled()
                    return ("cancel", None)
                working_since = now
        elif not loaded:
            working_since = None
            remaining = int(load_deadline - now)
            if remaining <= 0:
                return ("fatal", f"el modelo no terminó de cargar tras {load_wait}s")
            phase_print(f"Cargando modelo remoto... ({remaining}s restantes)")
        else:
            working_since = None
            if idle_since is None:
                idle_since = now
                console.print("[dim]Modelo cargado y servidor libre; esperando respuesta...[/]")
            if now - idle_since > IDLE_GRACE:
                return ("retry", "el servidor está idle y no hay respuesta (petición perdida)")
        time.sleep(POLL_INTERVAL)


def run_llm_request(
    url: str,
    payload: bytes,
    model_id: str,
    base_url: str,
    socket_timeout: int,
    monitor: bool,
    max_attempts: int = 3,
) -> Optional[str]:
    """Send a chat completion with retries. Returns response content or None."""
    reset_cancelled()
    base = derive_host_base(base_url)
    load_wait = startup_wait_seconds()
    load_deadline = time.monotonic() + load_wait

    if monitor:
        console.print(f"[dim]Enviando petición simple para forzar la carga del modelo: {model_id}[/]")
        _start_warmup_request(url, model_id, max(120, load_wait))

    for attempt in range(1, max_attempts + 1):
        status, value = send_monitored(url, payload, model_id, base, socket_timeout, load_deadline, monitor)
        if status == "ok":
            return value
        if status == "cancel":
            console.print("[red]✗ Cancelado por el usuario mientras el servidor procesaba.[/]")
            return None
        if status == "fatal":
            console.print(f"[red]✗ LLM API: {value}[/]")
            return None
        console.print(f"[yellow]⚠ LLM API error: {value} (intento {attempt}/{max_attempts})[/]")
        if attempt < max_attempts:
            wait_seconds = attempt * 3
            console.print(f"[dim]Reintentando en {wait_seconds}s...[/]")
            time.sleep(wait_seconds)
    console.print("[red]✗ No se pudo obtener respuesta del LLM tras los intentos.[/]")
    return None
