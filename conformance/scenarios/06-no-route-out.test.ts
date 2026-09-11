import { describe, test } from 'bun:test';
import { scenario } from '../scenarios.ts';

const s = scenario(6);

/**
 * Egress from inside the runtime container.
 *
 * Every one of these is `test.todo` and stays that way until a machine with
 * Docker runs them. There is nothing here a local process can prove: a Hermes
 * process on loopback has the host's default route, which is precisely the
 * thing the container is supposed not to have. Asserting it from outside the
 * container would test the assertion rather than the boundary.
 *
 * Each command is run as:
 *
 *   docker compose -f deploy/docker-compose.yml exec -T runtime sh -c '<command>'
 *
 * They use Python's standard library rather than curl, because
 * `python:3.12-slim` ships neither curl nor wget and the image deliberately
 * leaves no package manager behind. Python is present by construction.
 */
const PROBES: { assertion: string | undefined; command: string; expect: string }[] = [
  {
    assertion: s.assertions[0],
    // No default route means the connect fails in the kernel, not after a DNS
    // answer and a wait. A slow timeout here would mean the container can route
    // somewhere and is only being filtered, which is a weaker property.
    command:
      "python -c \"import socket,sys;socket.create_connection(('1.1.1.1',443),timeout=5);sys.exit('REACHED')\"",
    expect: 'OSError (ENETUNREACH/EHOSTUNREACH) in well under a second; never REACHED',
  },
  {
    assertion: s.assertions[1],
    command:
      "python -c \"import socket,sys;socket.create_connection(('postgres',5432),timeout=5);sys.exit('REACHED')\"",
    expect:
      'socket.gaierror. The name does not resolve, because postgres is not on a network ' +
      'the runtime shares. If it resolves at all, the compose networks are wrong.',
  },
  {
    assertion: s.assertions[2],
    // The cloud metadata address is how a container with any route at all
    // reaches credentials nobody gave it.
    command:
      "python -c \"import socket,sys;socket.create_connection(('169.254.169.254',80),timeout=5);sys.exit('REACHED')\"",
    expect: 'OSError in well under a second; never REACHED, and never an HTTP answer',
  },
  {
    assertion: s.assertions[3],
    command:
      "python -c \"import socket,sys;socket.create_connection(('web',3000),timeout=5);sys.exit('REACHED')\"",
    expect: 'socket.gaierror. The web service is on edge only, so the name does not resolve.',
  },
  {
    assertion: s.assertions[4],
    // The one thing that must work. An unauthenticated tools read is a 401,
    // which is proof the socket opened and the broker answered.
    command:
      'python -c "import urllib.request;print(urllib.request.urlopen(\'http://melete:8788/tools\',timeout=5).status)"',
    expect:
      'urllib.error.HTTPError: HTTP Error 401: Unauthorized. The 401 is the pass: the ' +
      'connection succeeded and the broker refused a read with no capability.',
  },
  {
    assertion: s.assertions[5],
    command: 'id -u; touch /etc/melete-probe; touch /work/melete-probe && rm /work/melete-probe',
    expect:
      '10001, then "Read-only file system" for /etc, then the /work write and delete both ' +
      'succeed. A root uid or a writable /etc means the compose hardening did not apply.',
  },
];

describe(`conformance 6: ${s.title}`, () => {
  for (const probe of PROBES) {
    // Unverified: this machine has no Docker. The body stays empty so a todo
    // can never be mistaken for a pass.
    test.todo(`${probe.assertion ?? 'unknown assertion'}\n      run:    ${probe.command}\n      expect: ${probe.expect}`, () => {});
  }
});
