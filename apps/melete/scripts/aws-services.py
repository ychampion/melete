"""
Writes apps/melete/src/egress/adapters/aws-services.json from the service
definitions the AWS SDK for Python ships (botocore's data directory): for each
AWS service, the host prefix and signing name it is reached by, the protocols
its endpoint accepts, the JSON target prefix, and the REST routes the egress
relay must recognise. A REST route is listed when its method is GET or HEAD
and its name does not read like a read, or when its name speaks of a
credential, token, key pair, password, secret or private key; every other GET
or HEAD route is a read by its name, and every other method is a change.

    python apps/melete/scripts/aws-services.py   (with botocore installed)
"""
import json
import os
import re

import botocore
from botocore.loaders import Loader

READ = re.compile(r'^(?:Get|List|Describe|Head|Query|Scan|BatchGet|Select|Lookup|Search|Filter)(?:[A-Z0-9]|$)')
SENSITIVE = re.compile(r'Credential|Token|KeyPair|Password|Secret|PrivateKey|Presigned|^Assume|Access')

loader = Loader()
services = []
for name in sorted(loader.list_available_services('service-2')):
    model = loader.load_service_model(name, 'service-2')
    meta = model['metadata']
    protocols = meta.get('protocols') or [meta['protocol']]
    entry = {
        'id': name,
        'prefix': meta.get('endpointPrefix', name),
        'signing': meta.get('signingName', meta.get('endpointPrefix', name)),
        'protocols': protocols,
    }
    if meta.get('targetPrefix'):
        entry['target'] = meta['targetPrefix']
    if meta['protocol'] in ('rest-json', 'rest-xml'):
        routes = []
        for op, shape in sorted(model['operations'].items()):
            http = shape.get('http', {})
            method = http.get('method', 'POST')
            if (method in ('GET', 'HEAD') and not READ.search(op)) or SENSITIVE.search(op):
                routes.append([method, http.get('requestUri', '/'), op])
        if routes:
            entry['routes'] = routes
    services.append(entry)

out = os.path.join(os.path.dirname(__file__), '..', 'src', 'egress', 'adapters', 'aws-services.json')
with open(out, 'w', encoding='utf-8', newline='\n') as handle:
    json.dump({'source': f'botocore {botocore.__version__}', 'services': services}, handle, indent=0, separators=(',', ':'))
    handle.write('\n')
print(len(services), os.path.getsize(out))
