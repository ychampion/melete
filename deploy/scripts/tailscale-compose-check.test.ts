import { describe, expect, test } from 'bun:test';
import {
  checkTailscaleCompose,
  loadServeConfig,
  loadTailscaleCompose,
  type ServeConfig,
  type TailscaleComposeFile,
  tailscaleComposePaths,
} from './tailscale-compose-check.ts';

/** The one serve host: tailscaled substitutes the node's certificate domain. */
const HOST = `\${TS_CERT_DOMAIN}:443`;
const paths = tailscaleComposePaths();
const base = loadTailscaleCompose(paths.base);
const override = loadTailscaleCompose(paths.override);
const kernel = loadTailscaleCompose(paths.kernel);
const serve = loadServeConfig(paths.serve);

const failures = (
  file: TailscaleComposeFile = override,
  {
    original = base,
    opt = kernel,
    config = serve,
  }: { original?: TailscaleComposeFile; opt?: TailscaleComposeFile; config?: ServeConfig } = {},
) =>
  checkTailscaleCompose(original, file, opt, config)
    .filter((result) => !result.ok)
    .map((result) => result.name);

function mutation(change: (node: Record<string, unknown>) => void) {
  const broken = structuredClone(override);
  const node = broken.services?.tailscale;
  if (!node) throw new Error('tailscale fixture is missing');
  change(node);
  return broken;
}

function serveMutation(change: (config: ServeConfig) => void) {
  const broken = structuredClone(serve);
  change(broken);
  return broken;
}

describe('the Tailscale deployment', () => {
  test('accepts the shipped additive override', () => {
    expect(failures()).toEqual([]);
  });

  test('the override parses together with the base file and adds one service', () => {
    // Compose merges by service name; nothing here may replace a base service.
    const merged = { ...base.services, ...override.services };
    expect(Object.keys(merged).sort()).toEqual([
      'melete',
      'postgres',
      'runtime',
      'runtime-image',
      'tailscale',
      'web',
    ]);
    // The web entry the override carries adds a setting and nothing else, so
    // the merged web service keeps the base ports, networks and image.
    expect(Object.keys(override.services?.web ?? {})).toEqual(['environment']);
    expect(base.services?.web?.ports).toEqual([`127.0.0.1:\${WEB_PORT:-3101}:3000`]);
    expect(base.services?.tailscale).toBeUndefined();
    expect(Object.keys(kernel.services ?? {})).toEqual(['tailscale']);
  });

  test('refuses a node on the database or runtime network', () => {
    for (const network of ['database', 'internal']) {
      const broken = mutation((node) => {
        node.networks = ['edge', network];
      });
      expect(failures(broken), network).toContain('the node joins the edge network only');
    }
  });

  test.each([
    ['ports', ['443:443']],
    ['env_file', ['.env']],
    ['secrets', ['master_key']],
    ['devices', ['/dev/net/tun:/dev/net/tun']],
    ['cap_add', ['NET_ADMIN']],
    ['privileged', true],
    ['network_mode', 'host'],
    ['pid', 'host'],
    ['user', '0:0'],
    ['command', ['sh']],
  ])('refuses the alternate privilege or exposure channel %s', (key, value) => {
    const broken = mutation((node) => {
      node[String(key)] = value;
    });
    expect(failures(broken)).toContain(
      'the node has no unreviewed privilege, device or credential channels',
    );
  });

  test('refuses publishing a host port from the node', () => {
    const broken = mutation((node) => {
      node.ports = ['127.0.0.1:8443:443'];
    });
    expect(failures(broken)).toContain('the node publishes nothing on a host interface');
  });

  test('refuses kernel networking smuggled into the default file', () => {
    for (const change of [
      (node: Record<string, unknown>) => {
        node.environment = { ...(node.environment as object), TS_USERSPACE: 'false' };
      },
      (node: Record<string, unknown>) => {
        node.devices = ['/dev/net/tun:/dev/net/tun'];
      },
      (node: Record<string, unknown>) => {
        node.cap_add = ['NET_ADMIN'];
      },
      (node: Record<string, unknown>) => {
        node.privileged = true;
      },
      (node: Record<string, unknown>) => {
        delete node.read_only;
      },
      (node: Record<string, unknown>) => {
        delete node.cap_drop;
      },
      (node: Record<string, unknown>) => {
        delete node.security_opt;
      },
    ]) {
      expect(failures(mutation(change))).toContain(
        'the node runs userspace networking without kernel privileges',
      );
    }
  });

  test.each([
    'tailscale/tailscale:latest',
    'tailscale/tailscale:stable',
    'tailscale/tailscale:unstable',
    'tailscale/tailscale',
    'tailscale/tailscale:v1.102',
  ])('refuses the moving image reference %s', (image) => {
    const broken = mutation((node) => {
      node.image = image;
    });
    expect(failures(broken)).toContain('the node image is pinned to a released version');
  });

  test('refuses unbounded logs on the node or on a base service', () => {
    const unset = mutation((node) => {
      delete node.logging;
    });
    expect(failures(unset)).toContain('the Tailscale stack keeps bounded logs');
    const unlimited = mutation((node) => {
      node.logging = { driver: 'json-file', options: { 'max-file': '5' } };
    });
    expect(failures(unlimited)).toContain('the Tailscale stack keeps bounded logs');
    const baseWithout = structuredClone(base);
    delete baseWithout.services?.web?.logging;
    expect(failures(override, { original: baseWithout })).toContain(
      'the Tailscale stack keeps bounded logs',
    );
  });

  test('refuses losing the node key to an anonymous or shared mount', () => {
    for (const volumes of [
      [],
      ['/var/lib/tailscale'],
      ['tailscale-state:/var/lib/tailscale'],
      ['spaces:/var/lib/tailscale', './config/tailscale-serve.json:/etc/tailscale/serve.json:ro'],
      [
        'tailscale-state:/var/lib/tailscale',
        './config:/etc/tailscale:ro',
        '/var/run/docker.sock:/var/run/docker.sock',
      ],
    ]) {
      const broken = mutation((node) => {
        node.volumes = volumes;
      });
      expect(failures(broken), JSON.stringify(volumes)).toContain(
        'the node key lives on a named volume and the serve configuration is read only',
      );
    }
  });

  test('refuses a writable serve configuration mount', () => {
    const broken = mutation((node) => {
      node.volumes = [
        'tailscale-state:/var/lib/tailscale',
        './config/tailscale-serve.json:/etc/tailscale/serve.json',
      ];
    });
    expect(failures(broken)).toContain(
      'the node key lives on a named volume and the serve configuration is read only',
    );
  });

  test.each([
    ['TS_AUTHKEY', 'tskey-auth-kPretendPretendPretend'],
    ['TS_AUTHKEY', ''],
    ['MELETE_MASTER_KEY', 'inherited'],
    ['DATABASE_URL', 'postgres://melete@postgres:5432/melete'],
  ])('refuses %s carrying a literal value into the node', (key, value) => {
    const broken = mutation((node) => {
      node.environment = { ...(node.environment as object), [key]: value };
    });
    expect(failures(broken)).toContain(
      'the auth key comes from the environment and no other secret is present',
    );
  });

  test('refuses accepting tailnet DNS, which would hide the web service', () => {
    const broken = mutation((node) => {
      node.environment = { ...(node.environment as object), TS_ACCEPT_DNS: 'true' };
    });
    expect(failures(broken)).toContain('the node keeps the resolver that finds the web service');
  });

  test('refuses an override that redefines a base service or adds a network', () => {
    const redefined = structuredClone(override);
    const web = redefined.services?.web;
    if (!web) throw new Error('web fixture is missing');
    web.ports = ['0.0.0.0:3101:3000'];
    expect(failures(redefined)).toContain(
      'the Tailscale override only adds its node and the web upstream setting',
    );
    const widened = structuredClone(override);
    widened.networks = { tailnet: { driver: 'bridge' } };
    expect(failures(widened)).toContain(
      'the Tailscale override only adds its node and the web upstream setting',
    );
  });

  test.each([
    (config: ServeConfig) => {
      const handlers = config.Web?.[HOST]?.Handlers;
      if (handlers) handlers['/'] = { Proxy: 'http://melete:8787' };
    },
    (config: ServeConfig) => {
      const handlers = config.Web?.[HOST]?.Handlers;
      if (handlers) handlers['/data'] = { Path: '/data' };
    },
    (config: ServeConfig) => {
      const handlers = config.Web?.[HOST]?.Handlers;
      if (handlers) handlers['/'] = { Proxy: 'http://web:3000', Path: '/etc' };
    },
    (config: ServeConfig) => {
      config.TCP = { '443': { HTTPS: true }, '22': { TCPForward: 'melete:22' } };
    },
    (config: ServeConfig) => {
      config.TCP = { '443': { HTTPS: false } };
    },
  ])('refuses a serve configuration that reaches past the web client (%#)', (change) => {
    expect(failures(override, { config: serveMutation(change) })).toContain(
      'the serve configuration answers one HTTPS host and proxies only the web client',
    );
  });

  test.each([
    (config: ServeConfig) => {
      config.AllowFunnel = { [HOST]: true };
    },
    (config: ServeConfig) => {
      config.AllowFunnel = {};
    },
    (config: ServeConfig) => {
      delete config.AllowFunnel;
    },
  ])('refuses a serve configuration that does not say Funnel is off (%#)', (change) => {
    expect(failures(override, { config: serveMutation(change) })).toContain(
      'Funnel is off, so nothing is published to the public internet',
    );
  });

  test.each([
    (opt: TailscaleComposeFile) => {
      const node = opt.services?.tailscale;
      if (node) node.privileged = true;
    },
    (opt: TailscaleComposeFile) => {
      const node = opt.services?.tailscale;
      if (node) node.cap_add = ['NET_ADMIN', 'SYS_ADMIN'];
    },
    (opt: TailscaleComposeFile) => {
      const node = opt.services?.tailscale;
      if (node) node.volumes = ['/:/host'];
    },
    (opt: TailscaleComposeFile) => {
      const node = opt.services?.tailscale;
      if (node) node.devices = ['/dev/net/tun:/dev/net/tun', '/dev/kmsg:/dev/kmsg'];
    },
    (opt: TailscaleComposeFile) => {
      opt.services = { ...opt.services, melete: { privileged: true } };
    },
  ])('refuses widening the kernel-mode opt-in (%#)', (change) => {
    const broken = structuredClone(kernel);
    change(broken);
    expect(failures(override, { opt: broken })).toContain(
      'the kernel-mode opt-in changes only the documented networking settings',
    );
  });
});
