"""Launch the pinned engine with an OS-selected, continuously held API port.

The source checkout stays untouched. This small aiohttp startup wrapper reports
the bound socket, since Hermes's API_SERVER_PORT=0 log only prints the requested
port. The supervisor reads the report from the attempt's private temporary home.
"""
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

from aiohttp import web


@contextmanager
def report_listener(path: Path):
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


if __name__ == '__main__':
    os.environ['API_SERVER_PORT'] = '0'
    sys.argv = ['hermes', 'gateway', 'run']
    with report_listener(Path(os.environ['MELETE_RUNTIME_ADDRESS_FILE'])):
        from hermes_cli.main import main
        main()
