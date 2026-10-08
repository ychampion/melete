"""The sandbox desktop's `text` command: a page's accessibility tree as elements on the screen.

The helper (`deploy/sandbox/melete-desktop`) runs inside the agent's computer,
where it reads the browser over the DevTools protocol. Here the protocol is a
scripted stand-in, so what is checked is what the helper makes of the answers:
which elements it keeps, where it says they are, and what a scrolling pane hides.
"""

from __future__ import annotations

import importlib.machinery
import pathlib
import re
import struct
import time
import types

import pytest

HELPER = pathlib.Path(__file__).resolve().parents[3] / "deploy" / "sandbox" / "melete-desktop"


@pytest.fixture(scope="module")
def desktop():
    loader = importlib.machinery.SourceFileLoader("melete_desktop", str(HELPER))
    module = types.ModuleType(loader.name)
    loader.exec_module(module)
    return module


def node(node_id, role, name="", parent=None, children=(), backend=None, value=None, props=(), ignored=False):
    entry = {
        "nodeId": node_id,
        "ignored": ignored,
        "role": {"value": role},
        "name": {"value": name},
        "childIds": list(children),
        "backendDOMNodeId": backend if backend is not None else int(node_id),
    }
    if parent is not None:
        entry["parentId"] = parent
    if value is not None:
        entry["value"] = {"value": value}
    entry["properties"] = [{"name": key, "value": {"value": got}} for key, got in props]
    return entry


#: A trip form with a time picker that scrolls: two options are scrolled out of it.
TREE = [
    node("1", "RootWebArea", "Trip planner", children=["2", "3", "4", "5", "6", "7", "8", "9"]),
    node("2", "textbox", "From", parent="1", children=["20"], value="Union Square"),
    node("20", "StaticText", "Union Square", parent="2"),
    node("3", "button", "Search", parent="1", children=["30"]),
    node("30", "StaticText", "Search", parent="3"),
    node("4", "checkbox", "Transit only", parent="1", props=[("checked", "true"), ("focusable", True)]),
    node("5", "generic", "", parent="1", ignored=True),
    node("6", "StaticText", "36 min, $11.65", parent="1"),
    node("7", "textbox", "Password", parent="1", children=["70"], value="hunter2secret"),
    node("70", "StaticText", "hunter2secret", parent="7"),
    node("8", "textbox", "Code", parent="1", value="424242", props=[("autocomplete", "one-time-code")]),
    node("9", "listbox", "", parent="1", children=["10", "11", "12"]),
    node("10", "option", "7:30 AM", parent="9"),
    node("11", "option", "8:00 AM", parent="9"),
    node("12", "option", "8:30 AM", parent="9"),
]

#: Page-pixel boxes, as getContentQuads gives them (unclipped).
BOXES = {
    2: (40, 100, 240, 120),
    3: (300, 100, 360, 120),
    4: (380, 104, 392, 116),
    6: (40, 140, 160, 160),
    7: (400, 100, 560, 120),
    70: (404, 102, 500, 118),
    8: (600, 100, 700, 120),
    9: (40, 200, 200, 260),
    10: (40, 170, 200, 200),  # scrolled above the picker
    11: (40, 200, 200, 230),
    12: (40, 230, 200, 260),
}


#: The page as the browser lists it.
TARGET = {"webSocketDebuggerUrl": "ws://127.0.0.1:9/page", "url": "https://trips.example/", "title": "Trip planner"}


class FakeDevTools:
    """Answers the calls the helper makes, for one page."""

    #: The page's secret fields, by DOM node id: the password input.
    secure = [7]

    def __init__(self, url):
        self.sent = {}
        self.last = 0
        self.looking_for = None

    def call(self, method, params=None):
        if method == "Runtime.evaluate" and params.get("returnByValue"):
            # screenX, screenY, outer and inner sizes: 80 pixels of browser above the page.
            if "location.href" in params["expression"]:
                # The page's own script can say it is somewhere else.
                return {"result": {"value": '[0, 0, 1024, 768, 1024, 688, "https://bank.example/", "Your bank", 0, 2000]'}}
            return {"result": {"value": "[0, 0, 1024, 768, 1024, 688, 0, 2000]"}}
        if method == "Runtime.evaluate":
            self.looking_for = "secure" if "password" in params["expression"] else "clips"
            return {"result": {"objectId": self.looking_for}}
        if method == "Runtime.callFunctionOn":
            if params["objectId"] == "secure":
                return {"result": {"value": [[0, 0, 1, 1]] * len(self.secure)}}
            return {"result": {"value": [[40, 200, 200, 260]]}}
        if method == "Runtime.getProperties":
            if params["objectId"] == "secure":
                return {"result": [{"name": str(i), "value": {"objectId": f"secure-{n}"}} for i, n in enumerate(self.secure)]}
            return {"result": [{"name": "0", "value": {"objectId": "picker"}}, {"name": "length", "value": {}}]}
        if method == "Accessibility.getFullAXTree":
            return {"nodes": TREE}
        return {}

    def send(self, method, params=None):
        self.last += 1
        self.sent[self.last] = (method, params)
        return self.last

    def answers(self, ids):
        out = {}
        for sent_id in ids:
            method, params = self.sent[sent_id]
            if method == "DOM.describeNode":
                oid = params["objectId"]
                out[sent_id] = {"node": {"backendNodeId": int(oid.split("-")[1]) if oid.startswith("secure-") else 9}}
            elif method == "DOM.getContentQuads":
                box = BOXES.get(params["backendNodeId"])
                if box is None:
                    out[sent_id] = None
                else:
                    x1, y1, x2, y2 = box
                    out[sent_id] = {"quads": [[x1, y1, x2, y1, x2, y2, x1, y2]]}
        return out

    def close(self):
        pass


@pytest.fixture()
def view(desktop, monkeypatch):
    monkeypatch.setattr(desktop, "DevToolsSocket", FakeDevTools)
    monkeypatch.setattr(desktop, "page_target", lambda port, title: TARGET)
    return desktop.accessibility_view(9222, "Trip planner")


def test_each_element_is_kept_once_with_its_role_name_value_state_and_screen_box(view):
    elements = {element["ref"]: element for element in view["elements"]}
    assert view["source"] == "accessibility"
    assert view["url"] == "https://trips.example/"
    # Page pixels move down by the browser's 80 pixels of bars.
    assert elements["n2"] == {
        "ref": "n2", "role": "textbox", "name": "From", "value": "Union Square", "box": [40, 180, 200, 20],
    }
    assert elements["n4"]["states"] == ["checked"]
    assert elements["n6"] == {"ref": "n6", "role": "text", "name": "36 min, $11.65", "box": [40, 220, 120, 20]}
    # Text a control already says by name or value is not said twice; an
    # ignored node and an unnamed pane say nothing of their own.
    assert "n20" not in elements and "n30" not in elements and "n5" not in elements


def test_what_a_scrolling_picker_hides_is_not_on_the_screen(view):
    names = [element.get("name") for element in view["elements"] if element["role"] == "option"]
    assert names == ["8:00 AM", "8:30 AM"]
    assert view["offscreen"] == 1


def test_ocr_words_become_lines_with_boxes(desktop):
    tsv = "\n".join([
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        "5\t1\t1\t1\t1\t1\t40\t100\t60\t20\t96\tLeave",
        "5\t1\t1\t1\t1\t2\t104\t101\t40\t19\t95\tnow",
        "5\t1\t1\t1\t2\t1\t40\t140\t80\t20\t91\t$11.65",
        "5\t1\t1\t1\t2\t2\t130\t140\t10\t20\t-1\t ",
    ])
    assert desktop.ocr_lines(tsv) == [
        {"ref": "t1", "role": "text", "name": "Leave now", "box": [40, 100, 104, 20]},
        {"ref": "t2", "role": "text", "name": "$11.65", "box": [40, 140, 80, 20]},
    ]


def test_a_name_is_one_bounded_line(desktop):
    assert desktop.clean("Pay\nnow\t please") == "Pay now please"
    assert len(desktop.clean("x" * 1000)) == desktop.MAX_FIELD


def test_a_secret_field_is_kept_without_its_value(view):
    elements = {element["ref"]: element for element in view["elements"]}
    text = repr(view)
    assert "hunter2secret" not in text and "424242" not in text
    # A password input, by its type, and a one-time code, by what it autocompletes.
    assert elements["n7"] == {"ref": "n7", "role": "textbox", "name": "Password", "states": ["protected"], "box": [400, 180, 160, 20]}
    assert elements["n8"]["states"] == ["protected"] and "value" not in elements["n8"]
    assert "n70" not in elements
    # Other fields keep theirs.
    assert elements["n2"]["value"] == "Union Square"


def test_when_secret_fields_cannot_be_found_no_value_is_read(desktop, monkeypatch):
    class Blind(FakeDevTools):
        def call(self, method, params=None):
            if method == "Runtime.evaluate" and "password" in (params or {}).get("expression", ""):
                raise OSError("the page went away")
            return super().call(method, params)

    monkeypatch.setattr(desktop, "DevToolsSocket", Blind)
    monkeypatch.setattr(desktop, "page_target", lambda port, title: TARGET)
    view = desktop.accessibility_view(9222, "Trip planner")
    assert not [element for element in view["elements"] if "value" in element]
    assert "hunter2secret" not in repr(view)


def test_the_address_and_title_are_the_browsers_not_what_the_page_says(view):
    # The page's script claims to be a bank; the browser lists where it is.
    assert view["url"] == "https://trips.example/"
    assert view["title"] == "Trip planner"
    assert "bank" not in repr(view)


def test_secret_fields_are_found_as_the_browser_tools_find_them(desktop):
    # Every kind of field the browser tools hold back by what it autocompletes
    # (a card's number and code among them) is a secret field here too.
    controller = (HELPER.parents[2] / "apps" / "melete" / "src" / "workers" / "browser" / "controller.ts").read_text(
        encoding="utf-8"
    )
    lists = set(re.findall(r"/((?:password|one-time-code|webauthn|cc-number|cc-csc)(?:\|[a-z-]+)+)/i", controller))
    assert lists, "the browser tools' list of secret autocomplete values was not found"
    for listed in lists:
        for kind in listed.split("|"):
            assert kind in desktop.SECRET_AUTOCOMPLETE.split("|"), kind
            assert kind in desktop.SECURE_FIELDS
    # A component's fields sit in its shadow root, which the tree shows.
    assert "shadowRoot" in desktop.SECURE_FIELDS


class Wire:
    """A socket that answers with what it was given, then the rest of `endless`, counting what is read."""

    def __init__(self, data, endless=b"", pause=0.0):
        self.data, self.endless, self.pause, self.read = bytearray(data), endless, pause, 0

    def settimeout(self, seconds):
        self.timeout = seconds

    def recv(self, size):
        if self.pause:
            time.sleep(self.pause)
        if not self.data:
            if not self.endless:
                return b""
            self.data += self.endless * 1024
        chunk = bytes(self.data[:size])
        del self.data[:size]
        self.read += len(chunk)
        if self.read > 200 << 20:
            raise AssertionError("kept reading")
        return chunk


def wired(desktop, wire, seconds=None):
    tools = object.__new__(desktop.DevToolsSocket)
    tools.sock, tools.buffer, tools.last, tools.timeout = wire, bytearray(), 0, 5.0
    tools.deadline = time.monotonic() + (seconds if seconds is not None else desktop.READ_SECONDS)
    return tools


def test_an_answer_too_large_to_hold_is_refused_before_it_is_read(desktop):
    # A text frame that says it is 64 MiB long, then that many bytes.
    wire = Wire(bytes([0x81, 127]) + struct.pack(">Q", 64 << 20), endless=b"x" * 64)
    with pytest.raises(OSError):
        wired(desktop, wire).receive()
    assert wire.read < 1 << 20


def test_a_page_that_answers_slowly_is_given_up_on(desktop):
    # Each byte comes promptly, but the whole never ends.
    wire = Wire(bytes([0x01, 126]) + struct.pack(">H", 60000), endless=b"x", pause=0.002)
    wire.recv = (lambda base: lambda size: base(1))(wire.recv)
    started = time.monotonic()
    with pytest.raises(OSError):
        wired(desktop, wire, seconds=0.5).receive()
    assert time.monotonic() - started < 5
