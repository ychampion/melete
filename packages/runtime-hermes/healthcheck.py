"""The API must answer and its run reservations must survive process death."""
import json
import os
import urllib.request

request = urllib.request.Request(
    'http://127.0.0.1:8790/v1/capabilities',
    headers={'Authorization': 'Bearer ' + os.environ['API_SERVER_KEY']},
)
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
    features = json.load(response)['features']['runs_idempotency']
    if not (features['supported'] and features['durable']):
        raise SystemExit('Durable run reservations are unavailable')
