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

The picture comes from the broker (``GET /actions/<id>/screenshot``), and only
for a succeeded screenshot of this attempt's job. The agent's own computer's is
in the job's workspace. A paired computer's is kept by the service outside any
workspace, so neither this runtime nor the agent's sandbox can open it; the
broker hands it over only when that computer lets cloud models see its screen,
and otherwise says it is kept private, which the model is told instead.

Each picture names the brokered action it came from in a JPEG comment
(``melete-screenshot:<action_id>``). The privacy router looks that action up,
and only a succeeded screenshot of this job counts: whose screen it shows comes
from the action, never from the picture. The gateway takes the comment out
before anything is sent. A picture with no valid mark is treated as the most
private kind.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("melete.plugin")

#: Set to ``1`` by whatever starts the engine when the attempt's model reads images.
VISION_ENV = "MELETE_ENGINE_SUPPORTS_VISION"

#: The tools whose receipt names a screenshot saved in the job's workspace.
SCREENSHOT_TOOLS = frozenset({"computer.screenshot", "device.screenshot", "device.browser_screenshot"})

#: ``SOURCE_MARK`` in apps/melete/src/gateway/images.ts.
SOURCE_MARK = "melete-screenshot:"

_ACTION_ID = re.compile(r"^act_[A-Za-z0-9]{1,64}$")

#: ``accountToolName`` in apps/melete/src/broker/catalog.ts: when two
#: connections offer the same tool, as two paired computers do, each is named
#: with a suffix for its connection.
_ACCOUNT_SUFFIX = re.compile(r"__[0-9a-f]{12}$")

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


class Withheld:
    """The broker's answer for a picture it keeps from the model, with the reason to give it."""

    def __init__(self, reason: str) -> None:
        self.reason = reason


#: Said beside a paired computer's screenshot to a model that is not shown pictures.
NOT_SHOWN = (
    "This model is not shown pictures. The screenshot is kept by Melete and is not a file "
    "you can open; say what you could not see rather than guessing at it."
)


def screenshot_path(result: Dict[str, Any]) -> Optional[str]:
    """The workspace path a successful screenshot receipt names, if any."""
    if result.get("status") != "succeeded":
        return None
    receipt = result.get("receipt")
    detail = receipt.get("detail") if isinstance(receipt, dict) else None
    path = detail.get("path") if isinstance(detail, dict) else None
    return path if isinstance(path, str) and path.lower().endswith(".png") else None


def encode(data: bytes, mark: str = "") -> Optional[str]:
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
            scaled.save(
                out,
                format="JPEG",
                quality=quality,
                optimize=True,
                comment=(SOURCE_MARK + mark).encode("ascii"),
            )
            text = base64.b64encode(out.getvalue()).decode("ascii")
            if len(text) <= MAX_ENCODED_BYTES:
                return text
    return None


def text_summary(name: str, result: Dict[str, Any], path: Optional[str]) -> str:
    """What stands in for the picture: the receipt, led by where the picture is.

    The engine shows this to a model that cannot take the picture, and keeps the
    first 200 characters of it in place of a picture it has retired, so the path
    comes first. A paired computer's screenshot has no path the agent can open.
    """
    detail = result.get("receipt", {}).get("detail", {})
    size = ""
    if isinstance(detail.get("width"), int) and isinstance(detail.get("height"), int):
        size = f" ({detail['width']}x{detail['height']})"
    where = f" saved at {path}" if path else ""
    return f"Screenshot from {name}{where}{size}. " + json.dumps(result, ensure_ascii=False)


def attach(
    name: str,
    result: Dict[str, Any],
    fetch: Optional[Callable[[str], Any]] = None,
) -> Any:
    """The result with its picture, for a model that reads images; else the receipt.

    ``fetch`` asks the broker for a screenshot by its action id: its bytes, a
    ``Withheld`` when it is kept from the model, or None when it has none.
    """
    tool = _ACCOUNT_SUFFIX.sub("", name)
    if tool not in SCREENSHOT_TOOLS or result.get("status") != "succeeded":
        return result
    own = tool == "computer.screenshot"
    if not enabled() or fetch is None:
        return result if own else {**result, "picture": NOT_SHOWN}
    path = screenshot_path(result)
    action_id = result.get("action_id")
    if (own and path is None) or not isinstance(action_id, str) or not _ACTION_ID.match(action_id):
        return result
    data = fetch(action_id)
    if isinstance(data, Withheld):
        return {**result, "picture": data.reason}
    if not isinstance(data, bytes) or not data or len(data) > MAX_SOURCE_BYTES:
        logger.warning("melete: the picture for %s could not be fetched; the receipt alone is sent", action_id)
        return result
    picture = encode(data, action_id)
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
