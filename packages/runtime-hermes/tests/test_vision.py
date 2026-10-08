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
from melete_plugin.vision import CANNOT_VIEW, MAX_EDGE, MAX_ENCODED_BYTES, VISION_ENV, encode  # noqa: E402

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


def test_a_computer_step_is_given_the_screenshot_taken_after_it(client, broker, workspace, monkeypatch):  # noqa: F811
    """A click, a key, a batch: each ends with a screenshot, which a vision model sees with the result."""
    monkeypatch.setenv(VISION_ENV, "1")
    for name in ("computer.click", "computer.batch", "computer.open__0123456789ab"):
        result = run(client, broker, name)
        assert isinstance(result, dict) and result["_multimodal"] is True, name
        assert decoded(result).size == (1280, 800)
        assert result["text_summary"].startswith(f"Screenshot after {name} saved at {SHOT}")


def test_a_computer_step_without_a_screenshot_is_its_receipt(client, broker, workspace, monkeypatch):  # noqa: F811
    """A step whose screenshot was not taken (a person took over) is the receipt alone."""
    monkeypatch.setenv(VISION_ENV, "1")
    broker.catalog = [screenshot_tool("computer.type")]
    record = receipt()
    del record["receipt"]["detail"]["path"]
    broker.action_record = record
    ctx = RecordingContext()
    register(ctx, client)
    assert isinstance(ctx.tools[0]["handler"]({"step": 1}, task_id="engine"), str)
    assert not [r for r in broker.requests if r["path"].endswith("/screenshot")]


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


def test_a_screenshot_from_one_of_two_paired_computers_is_shown(client, broker, workspace, monkeypatch):  # noqa: F811
    """With two paired computers each one's tools are named per connection
    (`accountToolName`); the picture still arrives."""
    monkeypatch.setenv(VISION_ENV, "1")
    broker.screenshots[ACTION] = png(800, 600)
    result = run(client, broker, "device.screenshot__0123456789ab", f"device/screenshot-{ACTION}.png")
    assert isinstance(result, dict) and result["_multimodal"] is True
    assert decoded(result).size == (800, 600)
    # A name that only looks like one is not a screenshot tool.
    assert isinstance(run(client, broker, "device.screenshot__notahexsuffix"), str)


def device_receipt() -> dict:
    """A paired computer's receipt: no path, since the picture is in no workspace."""
    return {
        "id": ACTION,
        "receipt": {
            "action_id": ACTION,
            "connection_id": CONNECTION,
            "external_ref": None,
            "detail": {"device": "Laptop", "bytes": 100, "width": 800, "height": 600, "content_hash": HASH},
        },
    }


def run_device(client, broker):  # noqa: F811
    broker.catalog = [screenshot_tool("device.screenshot")]
    broker.action_record = device_receipt()
    ctx = RecordingContext()
    register(ctx, client)
    return ctx.tools[0]["handler"]({}, task_id="engine")


def test_a_device_screenshot_with_no_path_is_shown_when_the_computer_allows_it(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    broker.screenshots[ACTION] = png(800, 600)
    result = run_device(client, broker)
    assert isinstance(result, dict) and result["_multimodal"] is True
    assert decoded(result).size == (800, 600)
    assert result["text_summary"].startswith("Screenshot from device.screenshot (800x600). ")


def test_a_device_screenshot_kept_private_is_said_so_and_never_shown(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "1")
    broker.screenshots[ACTION] = "The screenshot was taken and is kept private."
    result = run_device(client, broker)
    assert isinstance(result, str) and "image_url" not in result
    shown = json.loads(result)
    assert shown["picture"] == "The screenshot was taken and is kept private."
    assert "path" not in shown["receipt"]["detail"]


def test_a_model_without_vision_is_told_a_device_screenshot_is_not_a_file(client, broker, workspace, monkeypatch):  # noqa: F811
    monkeypatch.setenv(VISION_ENV, "0")
    shown = json.loads(run_device(client, broker))
    assert "not a file" in shown["picture"]
    assert not [r for r in broker.requests if r["path"].endswith("/screenshot")]


def test_a_text_only_model_gets_no_image_and_a_plain_note(client, broker, workspace, monkeypatch):  # noqa: F811
    """A model that can't view pictures is sent none, by itself or any other
    model: it gets the receipt, with the screen's text, and is told so plainly."""
    monkeypatch.setenv(VISION_ENV, "0")
    for name in ("computer.screenshot", "computer.click", "computer.batch"):
        broker.catalog = [screenshot_tool(name)]
        record = receipt()
        record["receipt"]["detail"]["screen_text"] = {"source": "accessibility", "lines": 'n39 button "Search" box=923,180,58,21'}
        broker.action_record = record
        ctx = RecordingContext()
        register(ctx, client)
        result = ctx.tools[0]["handler"]({"step": 1}, task_id="engine")
        assert isinstance(result, str), name
        assert "data:image" not in result and "base64" not in result
        shown = json.loads(result)
        assert shown["picture"] == CANNOT_VIEW
        assert shown["receipt"] == record["receipt"]
    # No picture was even fetched, and no model was asked about one.
    assert not [r for r in broker.requests if r["path"].endswith("/screenshot")]
    assert not [r for r in broker.requests if r["path"].startswith("/providers/")]


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


def test_a_device_picture_read_back_from_the_session_store_is_asked_for_again(monkeypatch):
    """The engine's store keeps a paired computer's screenshot as its receipt and
    the word [screenshot]; the next run gets the picture only from the broker."""
    from melete_plugin.vision import STORED_PICTURE, Withheld, restore

    monkeypatch.setenv(VISION_ENV, "1")
    result = {"status": "succeeded", "action_id": ACTION, "receipt": device_receipt()["receipt"]}
    stored = json.dumps(result) + STORED_PICTURE
    asked = []

    def fetch(action_id):
        asked.append(action_id)
        return png(800, 600)

    back = restore("device.screenshot", stored, fetch)
    assert asked == [ACTION]
    assert [part["type"] for part in back] == ["text", "image_url"]
    # Kept private now: the receipt and why, never a picture.
    kept = json.loads(restore("device.screenshot__0123456789ab", stored, lambda _id: Withheld("private")))
    assert kept["picture"] == "private"
    # The agent's own screenshot, anything not stored that way, and other tools are left alone.
    assert restore("computer.screenshot", stored, fetch) == stored
    assert restore("computer.click", stored, fetch) == stored
    assert restore("device.read_file", stored, fetch) == stored
    assert restore("device.screenshot", "plain text", fetch) == "plain text"
    assert asked == [ACTION]


def test_history_read_back_goes_through_the_registered_restorer():
    from melete_runtime_hooks import register_picture_restorer, restore_pictures

    history = [
        {"role": "user", "content": "look"},
        {"role": "tool", "tool_name": "device.screenshot", "content": "receipt"},
    ]
    register_picture_restorer(lambda name, content: f"{name}:{content}")
    try:
        assert restore_pictures(history)[1]["content"] == "device.screenshot:receipt"
        assert history[0]["content"] == "look"
        register_picture_restorer(lambda _name, _content: (_ for _ in ()).throw(RuntimeError()))
        assert restore_pictures(history)[1]["content"] == "device.screenshot:receipt"
    finally:
        register_picture_restorer(lambda _name, content: content)
