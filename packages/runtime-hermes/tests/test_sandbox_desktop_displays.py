"""The desktop helper's displays, one per chat.

The helper (`deploy/sandbox/melete-desktop`) runs inside the agent's computer.
These check what a display picks without starting a screen or a browser: the
profile a display's browser starts from, that a display given to another
chat is cleared first, and that a display outside the range is refused.
"""

import importlib.machinery
import pathlib
import types

import pytest

HELPER = pathlib.Path(__file__).resolve().parents[3] / "deploy" / "sandbox" / "melete-desktop"


@pytest.fixture()
def desktop():
    loader = importlib.machinery.SourceFileLoader("melete_desktop_displays", str(HELPER))
    module = types.ModuleType(loader.name)
    loader.exec_module(module)
    return module


def test_display_zero_keeps_the_computer_profile_and_another_gets_its_own(desktop):
    desktop.choose(0, "")
    assert desktop.PROFILE == desktop.BASE_PROFILE
    assert desktop.DISPLAY == ":0"
    desktop.choose(3, "sbd_A")
    assert desktop.PROFILE == desktop.BASE_PROFILE + "-d3"
    assert desktop.DISPLAY == ":3"
    assert desktop.BROWSER_LOG == "/tmp/browser-3.log"


def test_a_display_copy_keeps_sign_ins_and_leaves_out_locks_and_tabs(desktop, tmp_path, monkeypatch):
    base = tmp_path / "melete-browser"
    (base / "Default").mkdir(parents=True)
    (base / "Default" / "Cookies").write_text("signed in")
    (base / "Default" / "Sessions").mkdir()
    (base / "Default" / "Sessions" / "Tabs_1").write_text("another chat's tabs")
    (base / "SingletonLock").write_text("held")
    (base / "DevToolsActivePort").write_text("9222")
    monkeypatch.setattr(desktop, "BASE_PROFILE", str(base))
    desktop.choose(2, "sbd_B")
    desktop.copy_profile()
    copy = pathlib.Path(desktop.PROFILE)
    assert copy == tmp_path / "melete-browser-d2"
    assert (copy / "Default" / "Cookies").read_text() == "signed in"
    assert not (copy / "Default" / "Sessions").exists()
    assert not (copy / "SingletonLock").exists()
    assert not (copy / "DevToolsActivePort").exists()


def test_a_display_given_to_another_chat_is_cleared_first(desktop, tmp_path, monkeypatch):
    ended = []
    monkeypatch.setattr(desktop, "display_file", lambda name: str(tmp_path / f"display.{name}"))
    monkeypatch.setattr(desktop, "end_display", lambda: ended.append(desktop.NUMBER))
    desktop.choose(1, "sbd_A")
    desktop.claim_display("sbd_A")
    # Its first chat: nothing of anyone else's was on it, and it is cleared once.
    assert ended == [1]
    desktop.claim_display("sbd_A")
    assert ended == [1]
    desktop.claim_display("sbd_B")
    assert ended == [1, 1]
    assert (tmp_path / "display.owner").read_text().strip() == "sbd_B"


@pytest.mark.parametrize(
    "argv",
    [
        ["--display", "64", "screenshot"],
        ["--display", "-1", "screenshot"],
        ["--display", "one", "screenshot"],
        ["--owner", "sbd; reboot", "screenshot"],
    ],
)
def test_a_display_outside_the_range_or_an_owner_that_is_not_an_id_is_refused(desktop, argv):
    with pytest.raises(SystemExit):
        desktop.main(argv)


def test_stopping_a_display_another_chat_now_holds_leaves_it_running(desktop, tmp_path, monkeypatch):
    ended = []
    monkeypatch.setattr(desktop, "display_file", lambda name: str(tmp_path / f"display.{name}"))
    monkeypatch.setattr(desktop, "end_display", lambda: ended.append(desktop.NUMBER))
    monkeypatch.setattr(desktop, "wait_for_display", lambda: None)
    (tmp_path / "display.owner").write_text("sbd_B\n")
    # The stop for the chat that had display 4 before arrives after sbd_B took it.
    desktop.main(["--display", "4", "--owner", "sbd_A", "stop"])
    assert ended == []
    # Its own stop, or one for a display nobody has claimed, still ends it.
    desktop.main(["--display", "4", "--owner", "sbd_B", "stop"])
    assert ended == [4]
    (tmp_path / "display.owner").unlink()
    desktop.main(["--display", "4", "--owner", "sbd_A", "stop"])
    assert ended == [4, 4]
