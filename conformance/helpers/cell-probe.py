"""Run by docker exec inside the actual unprivileged runtime; standard library only."""
import json
import os
from pathlib import Path
import socket
import sys
import time
import urllib.error
import urllib.request

probe = json.loads(sys.argv[1])
started = time.monotonic()
mode = probe['mode']
result = {}


def http_check(url, post=False):
    request = urllib.request.Request(url, data=b'{}' if post else None,
                                     headers={'content-type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=3) as response:
            return {'status': response.status, 'body': response.read(512).decode()}
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'body': error.read(512).decode()}
    except urllib.error.URLError as error:
        return {'reachable': False, 'errno': getattr(error.reason, 'errno', None)}
    except OSError as error:
        return {'reachable': False, 'errno': error.errno}


if mode == 'connect':
    try:
        with socket.create_connection((probe['host'], probe['port']), timeout=2):
            result = {'reachable': True}
    except OSError as error:
        result = {'reachable': False, 'errno': error.errno, 'error': type(error).__name__}
elif mode == 'http':
    result = http_check(probe['url'], probe.get('post', False))
elif mode == 'control-plane':
    result = {'checks': [
        {'path': path, **http_check('http://melete:8787' + path, path != '/health')}
        for path in ['/setup', '/login', '/health']
    ]}
elif mode == 'route':
    routes = Path('/proc/net/route').read_text().splitlines()[1:]
    result = {'default_routes': [line for line in routes if line.split()[1] == '00000000']}
elif mode == 'sibling':
    job = probe['job']
    paths = [f'/work/{job}/secret.txt', f'/work/../{job}/secret.txt',
             f'/var/lib/hermes/../../work/{job}/secret.txt']
    reads = []
    for path in paths:
        try:
            Path(path).read_bytes()
            reads.append({'path': path, 'readable': True})
        except OSError as error:
            reads.append({'path': path, 'readable': False, 'errno': error.errno})
    own = Path('/work/sandbox-own-write')
    own.write_text('workspace control')
    own_readable = own.read_text() == 'workspace control'
    own.unlink()
    result = {'reads': reads, 'own_workspace_writable': own_readable}
elif mode == 'hardening':
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines()
                  if ':' in line)
    try:
        Path('/etc/sandbox-readonly-probe').write_text('must fail')
        root_write = True
    except OSError:
        root_write = False
    result = {'uid': os.getuid(), 'root_write': root_write,
              'effective_capabilities': status['CapEff'].strip(),
              'no_new_privileges': status['NoNewPrivs'].strip(),
              'docker_socket_present': Path('/var/run/docker.sock').exists()}
else:
    raise SystemExit('Unknown probe')
result['duration_ms'] = round((time.monotonic() - started) * 1000, 3)
print(json.dumps(result))
