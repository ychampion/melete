"""The API must answer and its run reservations must survive process death.

Whether reservations are durable is settled when the API server starts, so the
full capability list is read until it has said so once for the running server.
After that the check only asks whether the server answers, which costs the
server a small fraction of building that list. The server is the container's
main process: a new one has a new start time and is checked in full again.
"""
import json
import os
import urllib.request
from pathlib import Path

BASE = 'http://127.0.0.1:8790'
# The container's own temporary directory.
CHECKED = Path('/tmp/melete-runtime-durable')


def server_identity(proc: Path = Path('/proc')) -> str | None:
    """This boot and the main process's start time, or None when either cannot be read."""
    try:
        boot = (proc / 'sys/kernel/random/boot_id').read_text().strip()
        # The fields after the parenthesised command name; the start time is the 20th of them.
        started = (proc / '1/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None
    return f'{boot}:{started}'


def get(url: str) -> dict:
    request = urllib.request.Request(
        url, headers={'Authorization': 'Bearer ' + os.environ['API_SERVER_KEY']},
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
        return json.load(response)


def main(base: str = BASE, checked: Path = CHECKED, proc: Path = Path('/proc')) -> None:
    identity = server_identity(proc)
    try:
        known = identity is not None and checked.read_text() == identity
    except OSError:
        known = False
    if known:
        if get(base + '/v1/health').get('status') != 'ok':
            raise SystemExit('The API server does not report itself healthy')
        return
    features = get(base + '/v1/capabilities')['features']['runs_idempotency']
    if not (features['supported'] and features['durable']):
        raise SystemExit('Durable run reservations are unavailable')
    if identity is not None:
        try:
            checked.write_text(identity)
        except OSError:
            pass  # The next check reads the full list again.


if __name__ == '__main__':
    main()
