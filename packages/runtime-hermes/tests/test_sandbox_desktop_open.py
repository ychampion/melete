"""The sandbox desktop's `open` command: it says the page opened only when the browser shows it.

The helper (`deploy/sandbox/melete-desktop`) runs inside the agent's computer,
where it drives the visible browser. Here the display and the browser's
DevTools endpoint are scripted stand-ins, so what is checked is what the helper
decides from their answers: whether the page in front shows the address asked
for, and what it says when it does not.
"""

from __future__ import annotations

import importlib.machinery
import json
import pathlib
import types

import pytest

HELPER = pathlib.Path(__file__).resolve().parents[3] / "deploy" / "sandbox" / "melete-desktop"


@pytest.fixture()
def desktop():
    loader = importlib.machinery.SourceFileLoader("melete_desktop_open", str(HELPER))
    module = types.ModuleType(loader.name)
    loader.exec_module(module)
    return module


class Clock:
    """Time that moves only when the helper waits, so a 15-second wait takes no time."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Browser:
    """One tab in front, as the DevTools endpoint lists it, and what a navigation does to it."""

    def __init__(self, url, title, lands=None, error=None, typed=""):
        self.page = {"type": "page", "url": url, "title": title, "webSocketDebuggerUrl": "ws://127.0.0.1:9/page"}
        #: Where a navigation leaves the tab; None leaves it where it was.
        self.lands = lands
        self.error = error
        self.typed = typed
        self.navigated = []
        self.fronted = 0

    def socket(self, url, timeout=5.0, seconds=20.0):
        browser = self

        class Tools:
            def call(self, method, params=None):
                if method == "Page.bringToFront":
                    browser.fronted += 1
                    return {}
                if method == "Page.navigate":
                    browser.navigated.append(params["url"])
                    if browser.lands is not None:
                        browser.page["url"], browser.page["title"] = browser.lands
                    return {"frameId": "f", **({"errorText": browser.error} if browser.error else {})}
                if method == "Page.getNavigationHistory":
                    return {"currentIndex": 0, "entries": [{"url": browser.page["url"], "userTypedURL": browser.typed}]}
                raise OSError(f"unexpected {method}")

            def close(self):
                pass

        return Tools()


@pytest.fixture()
def drive(desktop, monkeypatch, capsys):
    """Run `open` against a running browser and return what it printed."""

    def run(browser, url):
        clock = Clock()
        monkeypatch.setattr(desktop, "time", types.SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep))
        monkeypatch.setattr(desktop, "browser_running", lambda: True)
        monkeypatch.setattr(desktop, "browser_windows", lambda: ["5"])
        monkeypatch.setattr(desktop, "front_browser_window", lambda: None)
        monkeypatch.setattr(desktop, "active_window", lambda: f"{browser.page['title']} - Chromium")
        monkeypatch.setattr(desktop, "devtools_port", lambda path=None: 9222)
        monkeypatch.setattr(desktop, "page_target", lambda port, title: dict(browser.page))
        monkeypatch.setattr(desktop, "DevToolsSocket", browser.socket)
        monkeypatch.setattr(desktop, "xdotool", lambda *args, check=True: pytest.fail("no keys are typed"))
        desktop.open_url(url)
        return json.loads(capsys.readouterr().out)

    return run


def test_an_open_that_leaves_an_earlier_page_in_front_says_so_and_what_is_showing(drive):
    browser = Browser("https://www.google.com/travel/flights", "Google Flights")
    said = drive(browser, "https://httpbin.org/forms/post")
    assert browser.navigated == ["https://httpbin.org/forms/post"]
    assert said["navigated"] is False
    assert said["address"] == "https://www.google.com/travel/flights"
    assert said["window"] == "Google Flights - Chromium"
    assert said["checked"] == "address"
    assert said["reason"] == "the page in front is still another one"


def test_an_open_counts_once_the_page_in_front_shows_the_address(drive):
    browser = Browser(
        "https://www.google.com/maps", "Google Maps", lands=("https://httpbin.org/forms/post", "httpbin")
    )
    said = drive(browser, "http://httpbin.org/forms/post/")
    assert browser.fronted == 1
    assert said["navigated"] is True
    assert said["address"] == "https://httpbin.org/forms/post"
    assert "reason" not in said


def test_a_site_that_sends_the_browser_on_still_counts_as_the_address_asked_for(drive):
    browser = Browser(
        "https://example.org/old",
        "Old",
        lands=("https://accounts.example.com/landing?next=1", "Landing"),
        typed="https://go.example.com/start",
    )
    said = drive(browser, "https://go.example.com/start")
    assert said["navigated"] is True
    assert said["address"] == "https://accounts.example.com/landing?next=1"


def test_a_page_the_browser_could_not_load_says_why(drive):
    browser = Browser("https://example.org/", "Example", error="net::ERR_NAME_NOT_RESOLVED")
    said = drive(browser, "https://nowhere.invalid/")
    assert said["navigated"] is False
    assert said["address"] == "https://example.org/"
    assert said["reason"] == "the browser could not load it (net::ERR_NAME_NOT_RESOLVED)"


def test_an_error_page_at_the_address_is_not_the_page_opened(drive):
    browser = Browser(
        "https://example.org/",
        "Example",
        lands=("https://nowhere.invalid/", "nowhere.invalid"),
        error="net::ERR_CONNECTION_REFUSED",
    )
    said = drive(browser, "https://nowhere.invalid/")
    assert said["navigated"] is False
    assert said["address"] == "https://nowhere.invalid/"
    assert said["reason"] == "the browser could not load it (net::ERR_CONNECTION_REFUSED)"


def test_the_browser_window_is_brought_forward_rather_than_a_bubble_over_it(desktop, monkeypatch):
    names = {"5": "Google Flights - Chromium", "7": ""}
    activated = []
    monkeypatch.setattr(desktop, "browser_windows", lambda: ["5", "7"])
    monkeypatch.setattr(desktop, "window_name", lambda window: names[window])
    monkeypatch.setattr(
        desktop.subprocess, "run", lambda args, **kwargs: types.SimpleNamespace(stdout="7\n", returncode=0)
    )
    monkeypatch.setattr(desktop, "xdotool", lambda *args, check=True: activated.append(args))
    desktop.front_browser_window()
    assert activated == [("windowactivate", "--sync", "5")]


@pytest.mark.parametrize(
    ("asked", "shown", "same"),
    [
        ("https://example.com/a", "https://example.com/a", True),
        ("http://example.com/a/", "https://www.example.com/a", True),
        ("https://example.com/a b", "https://example.com/a%20b#top", True),
        ("https://example.com:443/", "https://example.com", True),
        ("https://example.com/a?q=1", "https://example.com/a?q=2", False),
        ("https://example.com/a", "https://example.org/a", False),
        ("https://example.com:8080/", "https://example.com/", False),
        ("https://example.com/", "chrome-error://chromewebdata/", False),
    ],
)
def test_addresses_of_one_page_compare_equal(desktop, asked, shown, same):
    assert (desktop.comparable(asked) == desktop.comparable(shown)) is same
