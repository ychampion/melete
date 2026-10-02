"""A screenshot as the model sees it.

The broker's answer to a screenshot is a receipt: where the picture was saved
in the job's workspace, its size and its digest. A model that reads images is
also given the picture itself, through the engine's multimodal tool result
(``{"_multimodal": True, "content": [...], "text_summary": ...}``, accepted by
``tools/registry.py`` ``_normalize_handler_result`` at the pinned release). A
model that does not is given the receipt exactly as before.

The engine decides the rest, and none of it is changed here:

- ``agent/vision_message_prep.py`` sends the text summary instead whenever the
  active model is not configured to read images (``model.supports_vision``).
- ``agent/context_compressor.py`` keeps the newest three tool pictures in every
  request it sends and replaces older ones with their text summary.
- The pinned engine estimates every picture at a flat number of tokens, so the
  picture is made small here: at most 1280 pixels on its longest side, as JPEG,
  lowering the quality and then the size until it fits the gateway's per-picture
  limit. The numbers match ``packages/contracts/src/model-vision.ts``.

The picture is read only from the job's own workspace, through the same path
checks commands use, and only for a receipt the broker returned for a screenshot
tool that succeeded.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .execution import DEFAULT_WORK_DIR, WORK_DIR_ENV, ExecRefused, resolve_in_workspace

logger = logging.getLogger("melete.plugin")

#: Set to ``1`` by whatever starts the engine when the attempt's model reads images.
VISION_ENV = "MELETE_ENGINE_SUPPORTS_VISION"

#: The tools whose receipt names a screenshot saved in the job's workspace.
SCREENSHOT_TOOLS = frozenset({"computer.screenshot", "device.screenshot", "device.browser_screenshot"})

#: ``VISION_IMAGE_MAX_EDGE`` in the contracts package.
MAX_EDGE = 1280

#: ``MAX_IMAGE_ENCODED_BYTES`` in the contracts package: the base64 text of one picture.
MAX_ENCODED_BYTES = 128 * 1024

#: The largest saved file read at all. A screenshot is a few megabytes at most.
MAX_SOURCE_BYTES = 16 * 1024 * 1024

#: Tried in order until the picture fits; then the size is lowered.
QUALITIES = (80, 65, 50, 35)
SMALLER_EDGES = (1024, 800, 640)


def enabled() -> bool:
    """True when this attempt's model is shown pictures."""
    return os.environ.get(VISION_ENV) == "1"


def _workspace() -> Path:
    """The job's workspace: ``/work`` in a container, the job's directory otherwise."""
    return Path(os.environ.get(WORK_DIR_ENV) or os.environ.get("TERMINAL_CWD") or DEFAULT_WORK_DIR)


def screenshot_path(result: Dict[str, Any]) -> Optional[str]:
    """The workspace path a successful screenshot receipt names, if any."""
    if result.get("status") != "succeeded":
        return None
    receipt = result.get("receipt")
    detail = receipt.get("detail") if isinstance(receipt, dict) else None
    path = detail.get("path") if isinstance(detail, dict) else None
    return path if isinstance(path, str) and path.lower().endswith(".png") else None


def encode(data: bytes) -> Optional[str]:
    """The picture as base64 JPEG within the per-picture limit, or None.

    None when Pillow is missing or the bytes are not a picture it can read; the
    model then gets the receipt alone, which is what it got before.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - present in the pinned engine's environment
        logger.warning("melete: Pillow is not available; screenshots are sent as receipts")
        return None
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            picture = source.convert("RGB")
    except Exception as error:  # noqa: BLE001 - any unreadable picture is the same answer
        logger.warning("melete: a screenshot could not be read: %s", type(error).__name__)
        return None
    for edge in (MAX_EDGE, *SMALLER_EDGES):
        scaled = picture
        if max(picture.size) > edge:
            ratio = edge / max(picture.size)
            size = (max(1, round(picture.width * ratio)), max(1, round(picture.height * ratio)))
            scaled = picture.resize(size, Image.LANCZOS)
        for quality in QUALITIES:
            out = io.BytesIO()
            scaled.save(out, format="JPEG", quality=quality, optimize=True)
            text = base64.b64encode(out.getvalue()).decode("ascii")
            if len(text) <= MAX_ENCODED_BYTES:
                return text
    return None


def text_summary(name: str, result: Dict[str, Any], path: str) -> str:
    """What stands in for the picture: the receipt, led by where the picture is.

    The engine shows this to a model that cannot take the picture, and keeps the
    first 200 characters of it in place of a picture it has retired, so the path
    comes first.
    """
    detail = result.get("receipt", {}).get("detail", {})
    size = ""
    if isinstance(detail.get("width"), int) and isinstance(detail.get("height"), int):
        size = f" ({detail['width']}x{detail['height']})"
    return f"Screenshot from {name} saved at {path}{size}. " + json.dumps(result, ensure_ascii=False)


def attach(name: str, result: Dict[str, Any]) -> Any:
    """The result with its picture, for a model that reads images; else unchanged."""
    if name not in SCREENSHOT_TOOLS or not enabled():
        return result
    path = screenshot_path(result)
    if path is None:
        return result
    try:
        file = resolve_in_workspace(_workspace(), path)
        if file.stat().st_size > MAX_SOURCE_BYTES:
            return result
        data = file.read_bytes()
    except (ExecRefused, OSError) as error:
        logger.warning("melete: the screenshot at %s could not be read: %s", path, error)
        return result
    picture = encode(data)
    if picture is None:
        return result
    summary = text_summary(name, result, path)
    return {
        "_multimodal": True,
        "content": [
            {"type": "text", "text": json.dumps(result, ensure_ascii=False)},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{picture}"}},
        ],
        "text_summary": summary,
    }
