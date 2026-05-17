import os
import json as _json
import sys as _sys
from pathlib import Path as _Path

# Load API keys from gitignored keys.json (sibling to this file). Same
# secrets store the Node.js side reads — see keys.example.json for the
# expected shape. Existing env vars win, so containerized / CI flows
# that inject via env still work.
#
# History note: this line used to hard-code OPENAI_API_KEY as a literal,
# which got committed to b97f3bb and lived in tracked history. Don't
# put literal secrets back here — drop them into keys.json instead
# (which is .gitignore'd at the repo root).
_KEYS_FILE = _Path(__file__).resolve().parent / "keys.json"
if _KEYS_FILE.is_file():
    try:
        _local_keys = _json.loads(_KEYS_FILE.read_text(encoding="utf-8"))
        for _k, _v in _local_keys.items():
            if _v and _k not in os.environ:
                os.environ[_k] = str(_v)
    except Exception as _err:
        print(
            f"[agent_ws_server] keys.json present but unreadable: {_err}",
            file=_sys.stderr,
        )

import argparse
import asyncio
import base64
import io
import json
import logging
import platform
import ssl
import sys
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

import pyautogui
from PIL import Image

from gui_agents.s2_5.agents.grounding import OSWorldACI
from gui_agents.s2_5.agents.agent_s import AgentS2_5

# Prefer websockets; installed widely and works on Windows
try:
    import websockets
    from websockets.server import WebSocketServerProtocol
except Exception as error:  # pragma: no cover
    print("Missing dependency 'websockets'. Please install via: pip install websockets", file=sys.stderr)
    raise


logger = logging.getLogger("agent_ws_server")
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(logging.Formatter("[%(asctime)s %(levelname)s] %(message)s"))
logger.addHandler(handler)
logger.setLevel(logging.INFO)


class AgentRuntime:
    """Encapsulates agent initialization and task execution."""

    def __init__(self,
                 provider: str = "openai",
                 model: str = "gpt-5-chat-latest",
                 model_url: str = "",
                 model_api_key: str = "",
                 model_temperature: Optional[float] = 0.0,
                 ground_provider: str = "vllm",
                 ground_url: str = "http://192.168.1.20:8021/v1",
                 ground_api_key: str = "ByteDance-Seed/UI-TARS-1.5-7B",
                 ground_model: str = "ByteDance-Seed/UI-TARS-1.5-7B",
                 ground_width: int = 1920,
                 ground_height: int = 1080,
                 max_trajectory_length: int = 4,
                 enable_reflection: bool = False) -> None:
        self.current_platform: str = platform.system().lower()

        screen_width, screen_height = pyautogui.size()
        self.scaled_width, self.scaled_height = self._scale_screen_dimensions(
            screen_width, screen_height, max_dim_size=2400
        )

        engine_params: Dict[str, Any] = {
            "engine_type": provider,
            "model": model,
            "base_url": model_url,
            "api_key": model_api_key,
            "temperature": model_temperature,
        }

        engine_params_for_grounding: Dict[str, Any] = {
            "engine_type": ground_provider,
            "model": ground_model,
            "base_url": ground_url,
            "api_key": ground_api_key,
            "grounding_width": ground_width,
            "grounding_height": ground_height,
        }

        grounding_agent = OSWorldACI(
            platform=self.current_platform,
            engine_params_for_generation=engine_params,
            engine_params_for_grounding=engine_params_for_grounding,
            width=screen_width,
            height=screen_height,
        )

        self.agent = AgentS2_5(
            engine_params,
            grounding_agent,
            platform=self.current_platform,
            max_trajectory_length=max_trajectory_length,
            enable_reflection=enable_reflection,
        )

    @staticmethod
    def _scale_screen_dimensions(width: int, height: int, max_dim_size: int) -> Tuple[int, int]:
        scale_factor = min(max_dim_size / width, max_dim_size / height, 1)
        safe_width = int(width * scale_factor)
        safe_height = int(height * scale_factor)
        return safe_width, safe_height

    async def run_task(self,
                       instruction: str,
                       on_event: Callable[[Dict[str, Any]], Awaitable[None]]) -> None:
        """Runs the agent loop, streaming events via on_event."""
        obs: Dict[str, Any] = {}
        self.agent.reset()

        # Inform start
        await on_event({"type": "log", "message": f"Start task: {instruction}"})

        for step_index in range(5):
            # Screenshot and downscale
            screenshot = pyautogui.screenshot()
            screenshot = screenshot.resize((self.scaled_width, self.scaled_height), Image.LANCZOS)

            buffered = io.BytesIO()
            screenshot.save(buffered, format="PNG")
            screenshot_bytes = buffered.getvalue()
            obs["screenshot"] = screenshot_bytes

            # Stream screenshot preview (base64) to client
            try:
                # Compress preview to reduce payload size
                preview = Image.open(io.BytesIO(screenshot_bytes))
                preview = preview.convert("RGB")
                preview_buffer = io.BytesIO()
                preview.save(preview_buffer, format="JPEG", quality=50, optimize=True)
                preview_b64 = base64.b64encode(preview_buffer.getvalue()).decode("ascii")
                await on_event({
                    "type": "screenshot",
                    "step": step_index + 1,
                    "image": preview_b64,
                    "encoding": "jpeg-base64",
                })
            except Exception:
                # Don't break task if client cannot receive images
                pass

            #await on_event({"type": "log", "message": f"Step {step_index + 1}/5: requesting action"})

            # Call agent to get next action
            info, code = self.agent.predict(instruction=instruction, observation=obs)

            action_script: str = code[0] if isinstance(code, (list, tuple)) and code else str(code)

            # Termination conditions
            lower_script = action_script.lower()
            if ("done" in lower_script) or ("fail" in lower_script):
                await on_event({"type": "log", "message": f"Agent signaled termination: {action_script}"})
                break

            if "next" in lower_script:
                #await on_event({"type": "log", "message": "Agent requested NEXT; continuing"})
                continue

            if "wait" in lower_script:
                #await on_event({"type": "log", "message": "Agent requested WAIT; sleeping 1s"})
                await asyncio.sleep(1.5)
                continue

            await on_event({"type": "log", "message": f"Executing action: {action_script}"})

            # Execute action directly (as in cli_app.py). Consider sandboxing for safety in production.
            try:
                exec(action_script)
            except Exception as exec_error:
                await on_event({
                    "type": "log",
                    "level": "error",
                    "message": f"Execution error: {exec_error}",
                })

            await asyncio.sleep(0.5)

        await on_event({"type": "task_finished", "status": "ok"})


class WebSocketAgentServer:
    """WS server that accepts tasks and streams agent events back to the client."""

    def __init__(self,
                 host: str = "localhost",
                 port: int = 48909,
                 ssl_context: Optional[ssl.SSLContext] = None) -> None:
        self.host = host
        self.port = port
        self.ssl_context = ssl_context
        self.agent_runtime: Optional[AgentRuntime] = None
        self._task_lock = asyncio.Lock()

    async def _send_json(self, ws: WebSocketServerProtocol, payload: Dict[str, Any]) -> None:
        try:
            if payload['type'] == 'screenshot':
                print("Sending: [screenshot]")
            else:
                print("Sending: ", payload)
            await ws.send(json.dumps(payload))
        except Exception as send_error:
            logger.warning("Send failed: %s", send_error)

    async def _on_event(self, ws: WebSocketServerProtocol, event: Dict[str, Any]) -> None:
        await self._send_json(ws, event)

    async def _handle_task(self, ws: WebSocketServerProtocol, message: Dict[str, Any]) -> None:
        instruction: str = str(message.get("task", "")).strip()
        if not instruction:
            await self._send_json(ws, {"type": "task_finished", "status": "error", "error": "Empty task"})
            return

        # Single-task at a time across the server to avoid conflicting desktop actions
        if self._task_lock.locked():
            await self._send_json(ws, {"type": "task_finished", "status": "error", "error": "Agent busy"})
            return

        async with self._task_lock:
            try:
                if self.agent_runtime is None:
                    self.agent_runtime = AgentRuntime()

                await self.agent_runtime.run_task(
                    instruction,
                    on_event=lambda ev: self._on_event(ws, ev),
                )
            except Exception as error:
                await self._send_json(ws, {"type": "task_finished", "status": "error", "error": str(error)})

    async def _handler(self, ws: WebSocketServerProtocol) -> None:
        peer = getattr(ws, "remote_address", None)
        logger.info("Client connected: %s", peer)
        try:
            async for raw in ws:
                try:
                    message = json.loads(raw)
                except Exception:
                    await self._send_json(ws, {"type": "error", "error": "Invalid JSON"})
                    continue

                msg_type = message.get("type")
                if msg_type == "task":
                    await self._handle_task(ws, message)
                else:
                    await self._send_json(ws, {"type": "error", "error": f"Unknown message type: {msg_type}"})
        except websockets.exceptions.ConnectionClosed:
            logger.info("Client disconnected: %s", peer)
        except Exception as error:
            logger.exception("Connection error: %s", error)

    async def run(self) -> None:
        server = await websockets.serve(
            self._handler,
            self.host,
            self.port,
            ssl=self.ssl_context,
            max_size=None,  # allow large frames
            ping_interval=20,
            ping_timeout=20,
        )
        logger.info("Agent WS server listening on %s://%s:%d", "wss" if self.ssl_context else "ws", self.host, self.port)
        await server.wait_closed()


def build_ssl_context(certfile: Optional[str], keyfile: Optional[str], no_ssl: bool) -> Optional[ssl.SSLContext]:
    if no_ssl or not certfile or not keyfile:
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    # For local development, be permissive on ciphers and versions
    ctx.check_hostname = False
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Agent WebSocket server for AgentBridge")
    parser.add_argument("--host", type=str, default="localhost")
    parser.add_argument("--port", type=int, default=48909)
    parser.add_argument("--cert", type=str, default="localhost+2.pem", help="Path to TLS certificate (PEM)")
    parser.add_argument("--key", type=str, default="localhost+2-key.pem", help="Path to TLS private key (PEM)")
    parser.add_argument("--no_ssl", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ssl_ctx = build_ssl_context(args.cert or None, args.key or None, args.no_ssl)
    server = WebSocketAgentServer(host=args.host, port=args.port, ssl_context=ssl_ctx)
    asyncio.run(server.run())


if __name__ == "__main__":
    main()


