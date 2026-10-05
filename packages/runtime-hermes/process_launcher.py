"""Launch the pinned engine with an OS-selected, continuously held API port.

The source checkout stays untouched. This small aiohttp startup wrapper reports
the bound socket, since Hermes's API_SERVER_PORT=0 log only prints the requested
port. The supervisor reads the report from the attempt's private temporary home.

A spare engine (MELETE_RUNTIME_SPARE=1) is started before its attempt exists. It
imports the engine against the configuration the attempt will have, less the
attempt's capability, then waits for one line on stdin naming the attempt's
working directory and environment, and starts from there as an engine started
with them would. Any module that reads one of those values, or the working
directory, while it is imported would have read a value the attempt does not
have, so the spare reports that and exits instead of being used. The Melete
plugin, loaded on the way, fetches the attempt's tools only once it has one.

A spare in a container (MELETE_RUNTIME_HANDOFF=http) is handed its attempt over
its own port instead of stdin, writes its configuration again with the attempt's
capability, and serves on the fixed port the container was given.
"""
import importlib
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

SPARE_READY = 'melete-spare:ready'
SPARE_UNUSABLE = 'melete-spare:unusable'
# What an engine imports on its way to its first run, heaviest first.
PREWARM = (
    'hermes_cli.main',
    'gateway.run',
    'run_agent',
    'gateway.platforms.api_server',
    'openai',
    'aiohttp.web',
    'requests',
    'tools.tool_search',
    'nemo_relay',
    'agent.outbound_webhooks',
)
# Libraries `gateway run` imports as it loads its messaging platforms, which a
# spare otherwise imports only after its attempt has arrived: about a second of
# every handed-over attempt's start. They are third-party packages that read
# neither the engine's configuration nor an attempt's values as they import; a
# read of an attempt value is still caught below like any other. Some keep the
# working directory they were imported in (multiprocessing does), so only a
# container engine, whose directory is its workspace's mount point before and
# after its attempt, imports them ahead.
PREWARM_PLATFORM_LIBRARIES = (
    'discord',
    'discord.ext.commands',
    'slack_bolt',
    'slack_bolt.async_app',
    'slack_bolt.adapter.socket_mode.async_handler',
    'slack_sdk',
    'telegram',
    'telegram.ext',
    'tornado.web',
    'nacl.secret',
    'qrcode',
    'PIL.Image',
    'cryptography.hazmat.primitives.serialization',
    'multiprocessing',
    'unittest.mock',
)
# Modules known to ask for the working directory at import without keeping it
# for anything an attempt does: Rich shortens paths in the tracebacks it draws,
# tempfile lists it as a last-resort candidate after TEMP and TMP, and the
# engine's own startup compares sys.path entries to put its root first.
KEEPS_NO_WORKING_DIRECTORY = frozenset(('rich', 'tempfile', 'hermes_cli._startup_fast'))
# Reads of an attempt's value known not to keep it. The gateway's runner looks
# at TERMINAL_CWD as it is imported only to fill in a default when none is set;
# a spare has its own set, which the attempt's replaces.
READS_NOT_KEPT = frozenset((('TERMINAL_CWD', 'gateway.run'),))


@contextmanager
def report_listener(path: Path):
    from aiohttp import web

    original = web.TCPSite.start

    async def start(site):
        await original(site)
        if site._host == '127.0.0.1' and site._port == 0:
            sockets = site._server.sockets
            if len(sockets) != 1:
                raise RuntimeError('Expected one loopback runtime listener')
            port = sockets[0].getsockname()[1]
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'port': port}), encoding='utf-8')
            os.replace(temporary, path)

    web.TCPSite.start = start
    try:
        yield
    finally:
        web.TCPSite.start = original


def reads_working_directory(frame) -> bool:
    """Whether a call to getcwd from `frame` depends on the working directory.

    Resolving an absolute path asks for it without using it (ntpath.realpath
    always does); otherwise whoever resolved the path is the one asking.
    """
    if frame is not None:
        source = frame.f_code.co_filename
        if 'ntpath' in source or 'posixpath' in source:
            path = frame.f_locals.get('path')
            if isinstance(path, (str, bytes)) and os.path.isabs(path):
                return False
            frame = frame.f_back
    if frame is None:
        return True
    return frame.f_globals.get('__name__') not in KEEPS_NO_WORKING_DIRECTORY


def reader(frame) -> str | None:
    """The module that read an environment value, past os and the mapping machinery."""
    # The mapping methods live in _collections_abc, which names itself collections.abc.
    while frame is not None and frame.f_globals.get('__name__') in (
        'os',
        '_collections_abc',
        'collections.abc',
    ):
        frame = frame.f_back
    return None if frame is None else frame.f_globals.get('__name__')


@contextmanager
def watch_reads(names, working_directory=True):
    """Record what is read of the named environment values and the working directory.

    A container engine's working directory is the same before and after its
    attempt (its workspace takes the directory over), so it is not watched there.
    """
    seen = set()
    environ_type = type(os.environ)
    original_getitem = environ_type.__getitem__
    original_contains = environ_type.__contains__
    original_getcwd, original_getcwdb = os.getcwd, os.getcwdb

    def note(key, frame):
        if key in names and (key, reader(frame)) not in READS_NOT_KEPT:
            seen.add(key)

    def getitem(self, key):
        note(key, sys._getframe(1))
        return original_getitem(self, key)

    def contains(self, key):
        note(key, sys._getframe(1))
        return original_contains(self, key)

    def getcwd():
        if working_directory and reads_working_directory(sys._getframe(1)):
            seen.add('cwd')
        return original_getcwd()

    def getcwdb():
        if working_directory and reads_working_directory(sys._getframe(1)):
            seen.add('cwd')
        return original_getcwdb()

    environ_type.__getitem__ = getitem
    environ_type.__contains__ = contains
    os.getcwd, os.getcwdb = getcwd, getcwdb
    try:
        yield seen
    finally:
        environ_type.__getitem__ = original_getitem
        environ_type.__contains__ = original_contains
        os.getcwd, os.getcwdb = original_getcwd, original_getcwdb


def prewarm(names, working_directory=True) -> set:
    """Import the engine ahead of its attempt; returns whatever of the attempt was read."""
    modules = PREWARM if working_directory else PREWARM + PREWARM_PLATFORM_LIBRARIES
    with watch_reads(names, working_directory) as seen:
        for module in modules:
            try:
                importlib.import_module(module)
            except Exception:
                # The engine imports it again when it needs it, and fails there if it must.
                pass
        try:
            # The client package loads most of itself on first use. A client
            # that is never sent anything, pointed nowhere, loads it now.
            from openai import OpenAI

            client = OpenAI(api_key='prewarm', base_url='http://127.0.0.1:9/v1', max_retries=0)
            client.chat.completions  # noqa: B018
            client.close()
        except Exception:
            pass
        try:
            # What the first request made anyway: urllib's default opener, whose
            # HTTPS handler loads the system's certificates, and the engine's
            # one shared context for its CA bundle, which the runner has named.
            import urllib.request

            if urllib.request._opener is None:
                urllib.request.install_opener(urllib.request.build_opener())
            from agent.ssl_verify import resolve_httpx_verify

            resolve_httpx_verify()
        except Exception:
            pass
    return set(seen)


def receive_attempt(spare_cwd: str | None) -> None:
    """Take the attempt's working directory and environment from the supervisor."""
    line = sys.stdin.readline()
    if not line:
        raise SystemExit('The supervisor closed the spare engine before handing it an attempt')
    take_attempt(json.loads(line), spare_cwd)


def take_attempt(handoff, spare_cwd: str | None, allowed=None, prepare=None) -> None:
    """Start from the attempt's environment and directory, as if started with them.

    `allowed`, when given, is every name the handoff may set; anything else is
    refused. `prepare` runs once the environment is the attempt's and before
    anything held back for the attempt does.
    """
    environment = handoff.get('env') if isinstance(handoff, dict) else None
    if not isinstance(environment, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in environment.items()
    ):
        raise SystemExit('Invalid attempt handoff')
    if allowed is not None and not set(environment) <= set(allowed):
        raise SystemExit('The attempt handoff names a value the spare was not started without')
    if not isinstance(handoff.get('cwd'), str):
        raise SystemExit('Invalid attempt handoff')
    if os.environ.get('TERMINAL_CWD') != spare_cwd:
        # The configuration named the terminal's directory as the engine loaded,
        # and it would have replaced the attempt's own value just the same.
        environment = {key: value for key, value in environment.items() if key != 'TERMINAL_CWD'}
    os.environ.update(environment)
    for key in ('MELETE_RUNTIME_SPARE', 'MELETE_RUNTIME_SPARE_KEYS', 'MELETE_RUNTIME_HANDOFF'):
        os.environ.pop(key, None)
    os.chdir(handoff['cwd'])
    if prepare is not None:
        prepare()
    # What was held back for the attempt, the plugin's tools among it, now has one.
    hooks = sys.modules.get('melete_runtime_hooks')
    if hooks is not None:
        hooks.attempt_arrived()


HANDOFF_PATH = '/melete/handoff'
HANDOFF_LIMIT = 65_536


def await_handoff(host: str, port: int, key: str):
    """Serve one authenticated handoff on the engine's own port, then stop serving.

    A container engine is reached over its private network, not a pipe, so its
    attempt arrives the same way its runs later do. Until then a GET of the path
    answers once the engine has loaded, which is how the supervisor knows the
    spare is ready; nothing else is served, so a readiness probe of the engine's
    own API keeps waiting. The engine's own server binds the same port once this
    one has closed.
    """
    import hmac
    from http.server import BaseHTTPRequestHandler, HTTPServer

    received = {}

    class Handoff(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D102 - quiet: requests carry no secrets, but no noise either
            pass

        def authorised(self) -> bool:
            given = self.headers.get('authorization', '')
            return hmac.compare_digest(given.encode(), f'Bearer {key}'.encode())

        def answer(self, status: int) -> None:
            self.send_response(status)
            self.send_header('content-length', '0')
            self.send_header('connection', 'close')
            self.end_headers()

        def do_GET(self):  # noqa: N802 - the standard library's name
            if self.path != HANDOFF_PATH:
                return self.answer(404)
            self.answer(200 if self.authorised() else 401)

        def do_POST(self):  # noqa: N802 - the standard library's name
            if self.path != HANDOFF_PATH:
                return self.answer(404)
            if not self.authorised():
                return self.answer(401)
            try:
                length = int(self.headers.get('content-length', '0'))
                if length <= 0 or length > HANDOFF_LIMIT:
                    raise ValueError('size')
                handoff = json.loads(self.rfile.read(length))
                if not isinstance(handoff, dict):
                    raise ValueError('shape')
            except ValueError:
                return self.answer(400)
            received['handoff'] = handoff
            self.answer(204)

    server = HTTPServer((host, port), Handoff)
    try:
        while 'handoff' not in received:
            server.handle_request()
    finally:
        server.server_close()
    return received['handoff']


def render_attempt_configuration(started_with, handed) -> None:
    """Write the engine's configuration again, now with the attempt's capability.

    The program is the boot script's own, handed over by it, so a container
    engine started with its attempt and one handed it later are configured by
    the same code. It reads the environment the container was started with and
    the attempt's values, not what the engine mirrored into its own environment
    while it loaded (the engine fills in TERMINAL_ENV and the rest of its
    terminal defaults from its configuration as it imports).
    """
    program = started_with.get('MELETE_BOOT_CONFIG', '')
    if not program:
        raise SystemExit('The boot configuration program was not handed to the spare')
    environment = {**started_with, **handed}
    target = str(Path(environment['HERMES_HOME']) / 'config.yaml')
    loaded = dict(os.environ)
    saved = sys.argv
    sys.argv = ['-c', target]
    os.environ.clear()
    os.environ.update(environment)
    try:
        exec(compile(program, 'melete-boot-config', 'exec'), {'__name__': '__main__'})  # noqa: S102
    finally:
        sys.argv = saved
        os.environ.clear()
        os.environ.update(loaded)
        os.environ.pop('MELETE_BOOT_CONFIG', None)


if __name__ == '__main__':
    if os.environ.get('MELETE_RUNTIME_SPARE') == '1':
        started_with = dict(os.environ)
        watched = frozenset(filter(None, os.environ.get('MELETE_RUNTIME_SPARE_KEYS', '').split(',')))
        spare_cwd = os.environ.get('TERMINAL_CWD')
        sys.argv = ['hermes']
        # A container's directory is its workspace's mount point, before and after.
        read = prewarm(watched, os.environ.get('MELETE_RUNTIME_HANDOFF') != 'http')
        if read:
            print(f'{SPARE_UNUSABLE} {",".join(sorted(read))}', flush=True)
            raise SystemExit(3)
        print(SPARE_READY, flush=True)
        if os.environ.get('MELETE_RUNTIME_HANDOFF') == 'http':
            # A container engine: its port is fixed and the supervisor reaches
            # it by address, so there is no listener to report.
            handoff = await_handoff(
                os.environ.get('API_SERVER_HOST', '0.0.0.0'),
                int(os.environ['API_SERVER_PORT']),
                os.environ['API_SERVER_KEY'],
            )
            take_attempt(
                handoff,
                spare_cwd,
                allowed=watched,
                prepare=lambda: render_attempt_configuration(started_with, handoff['env']),
            )
            sys.argv = ['hermes', 'gateway', 'run']
            from hermes_cli.main import main
            main()
            raise SystemExit(0)
        receive_attempt(spare_cwd)
    os.environ['API_SERVER_PORT'] = '0'
    sys.argv = ['hermes', 'gateway', 'run']
    with report_listener(Path(os.environ['MELETE_RUNTIME_ADDRESS_FILE'])):
        from hermes_cli.main import main
        main()
