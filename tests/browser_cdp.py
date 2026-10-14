"""Bounded UI smoke test using headless Edge and only Python's standard library.

Run from the project: python tests/browser_smoke.py
The app runs against a temporary copy; the real tabs library is never changed.
The dedicated Edge profile is kept in tests/.browser-profile for reuse.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from urllib.request import urlopen


PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))


DEFAULT_EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


class CDP:
    """Minimal synchronous WebSocket/CDP client, including masked client frames."""

    def __init__(self, url: str):
        target = urlsplit(url)
        if target.scheme != "ws" or target.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("Only a loopback ws:// debugger is allowed.")
        self.socket = socket.create_connection((target.hostname, target.port), timeout=15)
        self.socket.settimeout(20)
        self.buffer = bytearray()
        self.sequence = 0
        self.events = []
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {target.path}{'?' + target.query if target.query else ''} HTTP/1.1\r\n"
            f"Host: {target.hostname}:{target.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.socket.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise ConnectionError("Debugger closed the WebSocket handshake.")
            self.buffer.extend(chunk)
            if len(self.buffer) > 65536:
                raise ConnectionError("Oversized WebSocket handshake.")
        headers, extra = bytes(self.buffer).split(b"\r\n\r\n", 1)
        self.buffer = bytearray(extra)
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        response_headers = dict(
            line.split(b":", 1) for line in headers.split(b"\r\n")[1:] if b":" in line
        )
        accept = next((value.strip() for name, value in response_headers.items() if name.lower() == b"sec-websocket-accept"), None)
        if not headers.startswith(b"HTTP/1.1 101 ") or accept != expected:
            raise ConnectionError("Debugger rejected the WebSocket handshake: " + headers.decode("latin1"))

    def _read(self, size: int) -> bytes:
        while len(self.buffer) < size:
            chunk = self.socket.recv(max(4096, size - len(self.buffer)))
            if not chunk:
                raise ConnectionError("Debugger WebSocket closed.")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def _send(self, payload: bytes, opcode: int = 1):
        size = len(payload)
        frame = bytearray((0x80 | opcode, 0x80 | (size if size < 126 else 126 if size < 65536 else 127)))
        if size >= 65536:
            frame.extend(struct.pack("!Q", size))
        elif size >= 126:
            frame.extend(struct.pack("!H", size))
        mask = os.urandom(4)
        frame.extend(mask)
        frame.extend(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(frame)

    def _message(self) -> dict:
        fragments = bytearray()
        while True:
            first, second = self._read(2)
            opcode = first & 15
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            if size > 32 * 1024 * 1024:
                raise ConnectionError("Oversized debugger frame.")
            mask = self._read(4) if second & 128 else None
            payload = self._read(size)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 8:
                raise ConnectionError("Debugger sent a close frame.")
            if opcode == 9:
                self._send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise ConnectionError(f"Unexpected debugger opcode: {opcode}")
            fragments.extend(payload)
            if first & 128:
                return json.loads(fragments.decode("utf-8"))

    def call(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self._send(json.dumps({"id": request_id, "method": method, "params": params or {}}).encode("utf-8"))
        deadline = time.monotonic() + 20
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Debugger command timed out: " + method)
            self.socket.settimeout(remaining)
            message = self._message()
            if message.get("id") != request_id:
                self.events.append(message)
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True, "userGesture": True,
        })
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise AssertionError(detail.get("exception", {}).get("description", detail.get("text", str(detail))))
        return result.get("result", {}).get("value")

    def wait(self, expression: str, message: str, timeout: float = 15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = self.evaluate(expression)
                if result:
                    return result
            except AssertionError as error:
                if "Cannot read" not in str(error) and "not defined" not in str(error):
                    raise
            time.sleep(0.1)
        raise AssertionError("Timed out: " + message)

    def click(self, selector: str):
        self.evaluate(f"document.querySelector({json.dumps(selector)}).click()")

    def fill(self, selector: str, value: str, event: str = "input"):
        self.evaluate(
            "(() => { const el = document.querySelector(" + json.dumps(selector) + ");"
            "if (!el) throw new Error('Missing input: ' + " + json.dumps(selector) + ");"
            "el.value = " + json.dumps(value) + ";"
            "el.dispatchEvent(new Event(" + json.dumps(event) + ", {bubbles:true})); })()"
        )

    def key(self, key: str, code: str | None = None, modifiers: int = 0, repeat: bool = False):
        code = code or ("Digit" + key if key.isdigit() else key)
        details = {"key":key,"code":code,"modifiers":modifiers}
        if key in ("Enter", " "):
            details["windowsVirtualKeyCode"] = 13 if key == "Enter" else 32
            details["nativeVirtualKeyCode"] = details["windowsVirtualKeyCode"]
        down = {"type":"keyDown", **details, "autoRepeat":repeat}
        if key in ("Enter", " ") and not modifiers:
            down["text"] = "\r" if key == "Enter" else " "
            down["unmodifiedText"] = down["text"]
        self.call("Input.dispatchKeyEvent", down)
        self.call("Input.dispatchKeyEvent", {"type": "keyUp", **details})

    def screenshot(self, path: Path):
        self.evaluate("window.scrollTo(0,0)")
        metrics = self.call("Page.getLayoutMetrics")
        size = metrics.get("cssContentSize", metrics["contentSize"])
        result = self.call("Page.captureScreenshot", {
            "format": "png", "fromSurface": True, "captureBeyondViewport": True,
            "clip": {"x": 0, "y": 0, "width": size["width"], "height": min(size["height"], 5000), "scale": 1},
        })
        path.write_bytes(base64.b64decode(result["data"]))

    def close(self):
        self.socket.close()


def assert_that(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)
    print("PASS " + message, flush=True)


def render_png(client: CDP, tab_expression: str) -> tuple[dict, bytes]:
    png = client.evaluate("""(async () => {
      const tab = await SAVED;
      const pages = await HangExport.renderPNG(tab);
      if (!Array.isArray(pages) || !pages.length) throw new Error('No PNG pages');
      const first = pages[0];
      const bytes = new Uint8Array(await first.blob.arrayBuffer());
      const bitmap = await createImageBitmap(first.blob);
      let binary = '';
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start,start+8192));
      const result = {name:first.name, type:first.blob.type, size:first.blob.size, width:bitmap.width, height:bitmap.height, bytes:btoa(binary), pages:pages.length};
      bitmap.close(); return result;
    })()""".replace("SAVED", tab_expression))
    return png, base64.b64decode(png.pop("bytes"))


def wait_debugger(port: int, process: subprocess.Popen) -> str:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Edge exited with status {process.returncode}.")
        try:
            with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return target["webSocketDebuggerUrl"]
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Headless Edge debugger did not start within 20 seconds.")


