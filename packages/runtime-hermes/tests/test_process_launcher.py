"""The child reports a port only after the OS has bound its live listener."""
import asyncio
import json
import socket
import sys
from pathlib import Path

import pytest
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from process_launcher import report_listener


def test_concurrent_ephemeral_listeners_report_distinct_held_ports(tmp_path):
    async def check():
        reports = [tmp_path / 'first.json', tmp_path / 'second.json']
        runners = [web.AppRunner(web.Application()), web.AppRunner(web.Application())]
        try:
            await asyncio.gather(*(runner.setup() for runner in runners))
            sites = [web.TCPSite(runner, '127.0.0.1', 0) for runner in runners]
            # Each child has its own reporter; both listeners remain live together.
            with report_listener(reports[0]):
                await sites[0].start()
            with report_listener(reports[1]):
                await sites[1].start()
            ports = [json.loads(path.read_text())['port'] for path in reports]
            assert all(0 < port < 65536 for port in ports)
            assert ports[0] != ports[1]
            for port in ports:
                with socket.socket() as contender:
                    with pytest.raises(OSError):
                        contender.bind(('127.0.0.1', port))
                reader, writer = await asyncio.open_connection('127.0.0.1', port)
                writer.close()
                await writer.wait_closed()
        finally:
            await asyncio.gather(*(runner.cleanup() for runner in runners))
    asyncio.run(check())


# -- a spare engine ----------------------------------------------------------------

import io  # noqa: E402
import os  # noqa: E402
import types  # noqa: E402

import process_launcher  # noqa: E402
from process_launcher import (  # noqa: E402
    prewarm,
    reads_working_directory,
    receive_attempt,
    watch_reads,
)

ATTEMPT_KEYS = frozenset({'MELETE_ATTEMPT_TOKEN', 'TERMINAL_CWD'})


def run_as(module_name, source):
    """Run `source` as the body of a module with this name, as an import would."""
    module = types.ModuleType(module_name)
    exec(compile(source, f'<{module_name}>', 'exec'), module.__dict__)
    return module


def test_a_read_of_an_attempt_value_while_loading_is_reported(monkeypatch):
    monkeypatch.setenv('MELETE_ATTEMPT_TOKEN', 'placeholder')
    with watch_reads(ATTEMPT_KEYS) as seen:
        run_as('some_engine_module', "import os\nTOKEN = os.environ.get('MELETE_ATTEMPT_TOKEN')")
        run_as('another', "import os\nHAS = 'MELETE_ATTEMPT_TOKEN' in os.environ")
    assert seen == {'MELETE_ATTEMPT_TOKEN'}


def test_the_runners_look_at_its_directory_is_not_a_read_it_keeps(monkeypatch):
    monkeypatch.setenv('TERMINAL_CWD', '/spare/home')
    with watch_reads(ATTEMPT_KEYS) as seen:
        run_as('gateway.run', "import os\n_configured_cwd = os.environ.get('TERMINAL_CWD', '')")
    assert seen == set()
    with watch_reads(ATTEMPT_KEYS) as seen:
        run_as('gateway.other', "import os\nCWD = os.getenv('TERMINAL_CWD')")
    assert seen == {'TERMINAL_CWD'}


def test_resolving_an_absolute_path_is_not_a_read_of_the_working_directory(tmp_path):
    with watch_reads(ATTEMPT_KEYS) as seen:
        os.path.realpath(str(tmp_path))
    assert seen == set()
    with watch_reads(ATTEMPT_KEYS) as seen:
        run_as('some_engine_module', "import os\nHERE = os.getcwd()")
    assert seen == {'cwd'}
    assert reads_working_directory(None) is True


def test_prewarm_reports_nothing_for_modules_that_read_nothing_of_the_attempt(monkeypatch):
    monkeypatch.setattr(process_launcher, 'PREWARM', ('json', 'a_module_that_is_not_installed'))
    assert prewarm(ATTEMPT_KEYS) == set()


def hooks_module(monkeypatch):
    module = types.ModuleType('melete_runtime_hooks')
    module.arrived = 0

    def attempt_arrived():
        module.arrived += 1

    module.attempt_arrived = attempt_arrived
    monkeypatch.setitem(sys.modules, 'melete_runtime_hooks', module)
    return module


def test_the_attempt_is_taken_as_if_the_engine_had_started_with_it(tmp_path, monkeypatch):
    hooks = hooks_module(monkeypatch)
    workspace = tmp_path / 'job'
    workspace.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('MELETE_RUNTIME_SPARE', '1')
    monkeypatch.setenv('MELETE_RUNTIME_SPARE_KEYS', 'MELETE_ATTEMPT_TOKEN,TERMINAL_CWD')
    monkeypatch.setenv('TERMINAL_CWD', '/spare/home')
    handoff = {'cwd': str(workspace), 'env': {'MELETE_ATTEMPT_TOKEN': 'cap', 'TERMINAL_CWD': str(workspace)}}
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(handoff) + '\n'))
    receive_attempt('/spare/home')
    assert os.environ['MELETE_ATTEMPT_TOKEN'] == 'cap'
    assert os.environ['TERMINAL_CWD'] == str(workspace)
    assert Path(os.getcwd()).resolve() == workspace.resolve()
    assert 'MELETE_RUNTIME_SPARE' not in os.environ
    assert 'MELETE_RUNTIME_SPARE_KEYS' not in os.environ
    assert hooks.arrived == 1


def test_a_directory_the_configuration_named_is_kept_as_it_would_have_been(tmp_path, monkeypatch):
    hooks_module(monkeypatch)
    monkeypatch.chdir(tmp_path)
    # The engine's configuration set the terminal's directory as it loaded.
    monkeypatch.setenv('TERMINAL_CWD', '/work')
    handoff = {'cwd': str(tmp_path), 'env': {'TERMINAL_CWD': str(tmp_path)}}
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(handoff) + '\n'))
    receive_attempt('/spare/home')
    assert os.environ['TERMINAL_CWD'] == '/work'


def test_a_closed_or_malformed_handoff_ends_the_spare(monkeypatch):
    monkeypatch.setattr(sys, 'stdin', io.StringIO(''))
    with pytest.raises(SystemExit):
        receive_attempt(None)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'cwd': '.', 'env': {'A': 1}}) + '\n'))
    with pytest.raises(SystemExit):
        receive_attempt(None)
