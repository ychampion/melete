"""The container check reads durability once per server, then only asks whether it answers."""
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

SPEC = importlib.util.spec_from_file_location(
    'healthcheck', Path(__file__).parents[1] / 'healthcheck.py',
)
healthcheck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(healthcheck)


class FakeServer:
    """The API server's two answers, with every path it was asked for."""

    def __init__(self, durable=True, status='ok'):
        self.durable = durable
        self.status = status
        self.paths = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):  # noqa: N802 - the standard library's name
                fake.paths.append(self.path)
                assert self.headers['Authorization'] == 'Bearer fixture-key'
                if self.path == '/v1/capabilities':
                    body = {'features': {'runs_idempotency': {
                        'supported': True, 'durable': fake.durable}}}
                elif self.path == '/v1/health':
                    body = {'status': fake.status}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def server():
    servers = []

    def start(**options):
        started = FakeServer(**options)
        servers.append(started)
        return started

    yield start
    for started in servers:
        started.close()


def fake_proc(root: Path, started: int, boot: str = 'boot-1') -> Path:
    (root / 'sys/kernel/random').mkdir(parents=True, exist_ok=True)
    (root / 'sys/kernel/random/boot_id').write_text(boot + '\n')
    (root / '1').mkdir(exist_ok=True)
    fields = ['S', '0', '1', '1', '0', '-1', '4194560'] + ['0'] * 12 + [str(started), '1000']
    (root / '1/stat').write_text('1 (hermes gateway) ' + ' '.join(fields) + '\n')
    return root


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setenv('API_SERVER_KEY', 'fixture-key')


def test_the_capability_list_is_read_once_per_server(tmp_path, server):
    api = server()
    proc = fake_proc(tmp_path / 'proc', 4242)
    checked = tmp_path / 'checked'
    for _ in range(3):
        healthcheck.main(api.base, checked, proc)
    assert api.paths == ['/v1/capabilities', '/v1/health', '/v1/health']


def test_a_new_server_process_is_checked_in_full_again(tmp_path, server):
    api = server()
    checked = tmp_path / 'checked'
    healthcheck.main(api.base, checked, fake_proc(tmp_path / 'proc', 4242))
    healthcheck.main(api.base, checked, fake_proc(tmp_path / 'proc', 9999))
    healthcheck.main(api.base, checked, fake_proc(tmp_path / 'proc', 9999, boot='boot-2'))
    assert api.paths == ['/v1/capabilities'] * 3


def test_reservations_that_would_not_survive_fail_every_check(tmp_path, server):
    api = server(durable=False)
    proc = fake_proc(tmp_path / 'proc', 4242)
    checked = tmp_path / 'checked'
    for _ in range(2):
        with pytest.raises(SystemExit, match='Durable run reservations are unavailable'):
            healthcheck.main(api.base, checked, proc)
    assert api.paths == ['/v1/capabilities'] * 2
    assert not checked.exists()


def test_a_server_that_stops_answering_well_fails_the_light_check(tmp_path, server):
    api = server()
    proc = fake_proc(tmp_path / 'proc', 4242)
    checked = tmp_path / 'checked'
    healthcheck.main(api.base, checked, proc)
    api.status = 'starting'
    with pytest.raises(SystemExit):
        healthcheck.main(api.base, checked, proc)
    api.close()
    with pytest.raises(OSError):
        healthcheck.main(api.base, checked, proc)


def test_without_a_readable_process_record_every_check_is_in_full(tmp_path, server):
    api = server()
    checked = tmp_path / 'checked'
    for _ in range(2):
        healthcheck.main(api.base, checked, tmp_path / 'missing')
    assert api.paths == ['/v1/capabilities'] * 2
    assert not checked.exists()
