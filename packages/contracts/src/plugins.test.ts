import { expect, test } from 'bun:test';
import { mcpStdioConnectionConfig } from './mcp.ts';
import { PLUGIN_CATALOG, pluginEntry, pluginInstallation } from './plugins.ts';

const entry = (id: string) => {
  const found = pluginEntry(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

test('every catalog entry installs as a valid stdio configuration from its required values', () => {
  for (const plugin of PLUGIN_CATALOG) {
    const values = Object.fromEntries(
      plugin.fields.filter((field) => field.required).map((field) => [field.name, 'value']),
    );
    const built = pluginInstallation(plugin, values);
    if (!built.ok) throw new Error(`${plugin.id}: ${built.error}`);
    const parsed = mcpStdioConnectionConfig.safeParse(built.config);
    expect(parsed.success ? plugin.id : parsed.error.issues).toBe(plugin.id);
  }
});

test('the fetch plugin reads any public site unless the person names sites', () => {
  const open = pluginInstallation(entry('fetch'), {});
  expect(open.ok && open.config.egress).toEqual(['*']);
  const narrowed = pluginInstallation(entry('fetch'), {
    sites: 'docs.example.com\nAPI.example.org',
  });
  expect(narrowed.ok && narrowed.config.egress).toEqual(['docs.example.com', 'api.example.org']);
  const refused = pluginInstallation(entry('fetch'), { sites: '10.0.0.1' });
  expect(refused.ok ? null : refused.error).toContain('is not a host name');
});

test('a plugin names what it is missing and takes nothing it does not ask for', () => {
  const missing = pluginInstallation(entry('github'), {});
  expect(missing.ok ? null : missing.error).toBe('GitHub token is needed.');
  const extra = pluginInstallation(entry('time'), { TZ: 'UTC' });
  expect(extra.ok ? null : extra.error).toBe('Time and time zones does not take TZ.');
  const github = pluginInstallation(entry('github'), { GITHUB_PERSONAL_ACCESS_TOKEN: 'token' });
  expect(github.ok && github.config.secret_env).toEqual([
    { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: 'token' },
  ]);
  expect(github.ok && github.config.egress).toEqual(['api.github.com']);
});
