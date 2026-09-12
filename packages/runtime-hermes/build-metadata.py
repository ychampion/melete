"""Assert the plugin content pin and write a deterministic CycloneDX inventory."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

root = Path('/opt/melete-runtime')
plugin = root / 'melete_plugin'
digest = hashlib.sha256()
for path in sorted(plugin.rglob('*')):
    if path.is_file() and '__pycache__' not in path.parts:
        digest.update(path.relative_to(plugin).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
commit, expected = sys.argv[1:]
actual = digest.hexdigest()
if actual != expected:
    raise SystemExit(f'Plugin content pin mismatch: expected {expected}, got {actual}')

components = []
for dist in importlib.metadata.distributions():
    name, version = dist.metadata['Name'], dist.version
    components.append({'type': 'library', 'name': name, 'version': version,
                       'purl': f'pkg:pypi/{name.lower().replace("_", "-")}@{version}'})
packages = subprocess.check_output(['dpkg-query', '-W', '-f=${Package}\t${Version}\n'], text=True)
for line in packages.splitlines():
    name, version = line.split('\t')
    components.append({'type': 'library', 'name': name, 'version': version,
                       'purl': f'pkg:deb/debian/{name}@{version}'})
components.append({'type': 'library', 'name': 'melete-plugin', 'version': actual,
                   'hashes': [{'alg': 'SHA-256', 'content': actual}]})
sbom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1,
        'metadata': {'component': {'type': 'application', 'name': 'melete-runtime',
                                   'version': commit}},
        'components': sorted(components, key=lambda c: (c['name'], c['version']))}
(root / 'sbom.cdx.json').write_text(json.dumps(sbom, indent=2, sort_keys=True) + '\n')
(root / 'build-info.json').write_text(json.dumps({'hermes_commit': commit, 'plugin_sha256': actual},
                                              indent=2, sort_keys=True) + '\n')
