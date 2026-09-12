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
