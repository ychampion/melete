"""Screenshots reach a model that reads images as pictures, and any other as text.

Driven through the registered handler against the same loopback fake broker as
test_plugin.py. The picture comes from the broker, which reads it for the
runtime: nothing here is put in a workspace the runtime could read itself.
"""

from __future__ import annotations

import base64
import io
import json
import random

import pytest
from PIL import Image

# test_plugin puts the plugin on the path, so it is imported first.
from test_plugin import ACTION, CONNECTION, HASH, RecordingContext, broker, client  # noqa: F401, I001

from melete_plugin import register  # noqa: E402
from melete_plugin.vision import MAX_EDGE, MAX_ENCODED_BYTES, VISION_ENV, encode  # noqa: E402

SHOT = f".melete/computer/{ACTION}.png"


def screenshot_tool(name: str = "computer.screenshot") -> dict:
    return {
        "name": name,
        "description": "Take a screenshot.",
        "input_schema": {"type": "object", "properties": {"step": {"type": "integer"}}},
        "effect_class": "read",
        "connection_id": CONNECTION,
    }


def png(width: int, height: int, noisy: bool = False) -> bytes:
    """A desktop-sized picture. Noise makes it hard to compress, like a photo."""
    picture = Image.new("RGB", (width, height), (240, 240, 236))
    if noisy:
        rng = random.Random(7)
        picture = Image.frombytes("RGB", (width, height), bytes(rng.getrandbits(8) for _ in range(width * height * 3)))
    out = io.BytesIO()
    picture.save(out, format="PNG")
    return out.getvalue()


@pytest.fixture()
def workspace(broker, tmp_path, monkeypatch):  # noqa: F811
    """The broker holds the screenshot; the runtime's own workspace is empty."""
    monkeypatch.setenv("MELETE_WORK_DIR", str(tmp_path))
    broker.screenshots[ACTION] = png(2560, 1600)
    return broker


def receipt(path: str = SHOT) -> dict:
    return {
        "id": ACTION,
        "receipt": {
            "action_id": ACTION,
            "connection_id": CONNECTION,
            "external_ref": None,
            "detail": {"computer": "screenshot", "path": path, "width": 2560, "height": 1600, "sha256": HASH},
        },
    }


def run(client, broker, name: str = "computer.screenshot", path: str = SHOT):  # noqa: F811
    broker.catalog = [screenshot_tool(name)]
    broker.action_record = receipt(path)
    ctx = RecordingContext()
    register(ctx, client)
    return ctx.tools[0]["handler"]({"step": 1}, task_id="engine")


def decoded(envelope: dict) -> Image.Image:
    url = envelope["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))


def test_a_vision_model_is_given_the_screenshot_as_a_picture(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    result = run(client, broker)
    assert isinstance(result, dict) and result["_multimodal"] is True
    text, image = result["content"]
    assert text["type"] == "text"
    # The receipt the model reads beside the picture is the one it always got.
    assert json.loads(text["text"])["receipt"]["detail"]["path"] == SHOT
    assert image["type"] == "image_url"
    picture = decoded(result)
    assert max(picture.size) == MAX_EDGE
    assert picture.size == (1280, 800)
    # What stands in once the engine retires the picture leads with where it is.
    assert result["text_summary"].startswith(f"Screenshot from computer.screenshot saved at {SHOT} (2560x1600).")


def test_a_paired_device_screenshot_is_shown_too(client, broker, workspace, monkeypatch):  # noqa: F811
    """A paired computer's screenshot is saved by the service as itself, and the
    runtime (another user) may not be able to read that file; the broker reads
    it, so the picture still arrives."""
    monkeypatch.setenv(VISION_ENV, "1")
    broker.screenshots[ACTION] = png(800, 600)
    result = run(client, broker, "device.screenshot", f"device/screenshot-{ACTION}.png")
    assert result["_multimodal"] is True
    assert decoded(result).size == (800, 600)
    fetch = [r for r in broker.requests if r["path"].endswith("/screenshot")]
    assert fetch == [
        {"method": "GET", "path": f"/actions/{ACTION}/screenshot", "body": None, "auth": "Bearer cap-token"}
    ]


def test_a_model_without_vision_gets_the_text_receipt_unchanged(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "0")
    result = run(client, broker)
    assert isinstance(result, str)
    assert json.loads(result) == {"status": "succeeded", "action_id": ACTION, "receipt": receipt()["receipt"]}


def test_without_a_vision_answer_the_receipt_is_text(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.delenv(VISION_ENV, raising=False)
    assert isinstance(run(client, broker), str)


def test_a_receipt_that_names_no_picture_asks_for_none(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    for path in ("notes.txt", ""):
        assert isinstance(run(client, broker, path=path), str)
    assert not [r for r in broker.requests if r["path"].endswith("/screenshot")]


def test_only_screenshot_tools_carry_pictures(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    assert isinstance(run(client, broker, "files.read"), str)


def test_a_missing_or_unreadable_picture_falls_back_to_the_receipt(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    broker.screenshots.clear()
    assert isinstance(run(client, broker), str)
    broker.screenshots[ACTION] = b"\x89PNG not really"
    assert isinstance(run(client, broker), str)


def test_a_hard_picture_is_shrunk_until_it_fits_the_gateway_limit():
    text = encode(png(1920, 1200, noisy=True))
    assert text is not None
    assert len(text) <= MAX_ENCODED_BYTES
    picture = Image.open(io.BytesIO(base64.b64decode(text)))
    assert max(picture.size) <= MAX_EDGE


def test_the_plugin_numbers_match_the_contracts():
    """packages/contracts/src/model-vision.ts is what the gateway enforces."""
    from pathlib import Path

    source = (Path(__file__).resolve().parents[3] / "packages/contracts/src/model-vision.ts").read_text()
    assert f"VISION_IMAGE_MAX_EDGE = {MAX_EDGE};" in source
    assert f"MAX_IMAGE_ENCODED_BYTES = {MAX_ENCODED_BYTES // 1024} * 1024;" in source


def test_each_picture_names_the_action_it_came_from(client, broker, workspace, monkeypatch):  # noqa: F811
    """The privacy router looks this action up to learn whose screen it is; the
    picture itself claims nothing more, and the gateway takes the mark out."""
    monkeypatch.setenv(VISION_ENV, "1")
    own = decoded(run(client, broker))
    assert own.info["comment"] == f"melete-screenshot:{ACTION}".encode()
    device = decoded(run(client, broker, "device.screenshot", f"device/screenshot-{ACTION}.png"))
    assert device.info["comment"] == f"melete-screenshot:{ACTION}".encode()


def test_a_result_without_a_real_action_id_is_sent_as_its_receipt(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    broker.propose_response = {**broker.propose_response, "action_id": "act_../../x"}
    assert isinstance(run(client, broker), str)
