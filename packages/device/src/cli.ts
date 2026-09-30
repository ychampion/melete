#!/usr/bin/env bun
/**
 * melete-device: connect this computer to your Melete agent.
 *
 *   melete-device                 pair if needed, then stay connected
 *   melete-device pair            pair with a code from Settings → Devices
 *   melete-device status          what this computer allows, and where Melete is
 *   melete-device folders         list, add or remove shared folders
 *   melete-device allow <what>    turn on commands, files, open_url or screenshot
 *   melete-device deny <what>     turn one off
 *   melete-device forget          delete the token kept on this computer
 *   melete-device browser install let the Melete browser extension reach this companion
 *   melete-device browser-host    run by the browser itself, never by hand
 *
 * Pairing options, for use without prompts:
 *   --url <address> --code <code> --name <name> --folder <path> (repeatable)
 *   --allow commands,files,open_url,screenshot,browser
 */
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DeviceAgent, defaultName, pair } from './agent.ts';
import { EXTENSION_ID, hostMain, installHost } from './browser.ts';
import {
  CAPABILITY_NAMES,
  type Capabilities,
  configDir,
  configPath,
  DEFAULT_LOCAL_CAPABILITIES,
  type Folder,
  folderName,
  forgetConfig,
  logPath,
  readConfig,
  writeConfig,
} from './config.ts';

type Options = { flags: Map<string, string[]>; rest: string[] };

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const value =
        inline ?? (argv[index + 1] && !argv[index + 1]?.startsWith('--') ? argv[++index] : 'true');
      flags.set(key, [...(flags.get(key) ?? []), value as string]);
    } else rest.push(arg);
  }
  return { flags, rest };
}

const say = (line = '') => process.stdout.write(`${line}\n`);

async function asker() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (question: string, fallback = '') => {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''} `)).trim();
      return answer || fallback;
    },
    yes: async (question: string, fallback: boolean) => {
      const answer = (await rl.question(`${question} [${fallback ? 'Y/n' : 'y/N'}] `))
        .trim()
        .toLowerCase();
      return answer ? answer.startsWith('y') : fallback;
    },
    close: () => rl.close(),
  };
}

async function folderFrom(path: string, taken: Folder[]): Promise<Folder> {
  const absolute = await realpath(resolve(path)).catch(() => null);
  if (!absolute || !(await lstat(absolute)).isDirectory())
    throw new Error(`${path} is not a folder on this computer.`);
  return { name: folderName(absolute, taken), path: absolute };
}

function showSettings(capabilities: Capabilities, folders: Folder[]) {
  for (const name of CAPABILITY_NAMES)
    say(`  ${capabilities[name] ? 'on ' : 'off'}  ${name.replace('_', ' ')}`);
  say(folders.length ? '  Shared folders:' : '  No shared folders.');
  for (const folder of folders) say(`    ${folder.name}  →  ${folder.path}`);
}

async function pairCommand(options: Options) {
  const flag = (name: string) => options.flags.get(name)?.at(-1);
  const interactive = !(flag('url') && flag('code'));
  const prompt = interactive ? await asker() : null;
  try {
    say('Connect this computer to Melete.');
    say('Open Melete → Settings → Devices → "Connect a computer" to get a code.');
    const address =
      flag('url') ?? (await prompt?.ask('Melete address (the page you open Melete at):'));
    const code = flag('code') ?? (await prompt?.ask('Pairing code:'));
    const name = flag('name') ?? (await prompt?.ask('Name for this computer:', defaultName()));
    const folders: Folder[] = [];
    for (const path of options.flags.get('folder') ?? [])
      folders.push(await folderFrom(path, folders));
    if (prompt && !options.flags.has('folder')) {
      const answer = await prompt.ask(
        'Folders the agent may use, separated by commas (leave empty for none):',
      );
      for (const path of answer
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean))
        folders.push(await folderFrom(path, folders));
    }
    const capabilities: Capabilities = { ...DEFAULT_LOCAL_CAPABILITIES };
    const allowed = flag('allow');
    if (allowed !== undefined) {
      for (const name of CAPABILITY_NAMES) capabilities[name] = false;
      for (const name of allowed
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)) {
        if (!(CAPABILITY_NAMES as readonly string[]).includes(name))
          throw new Error(`Unknown capability: ${name}`);
        capabilities[name as keyof Capabilities] = true;
      }
    } else if (prompt) {
      capabilities.files = await prompt.yes('Allow using files in those folders?', true);
      capabilities.open_url = await prompt.yes('Allow opening pages in your browser?', true);
      capabilities.screenshot = await prompt.yes('Allow screenshots of your screen?', false);
      capabilities.commands = await prompt.yes(
        'Allow running commands (each one still needs your approval in Melete)?',
        false,
      );
      capabilities.browser = await prompt.yes(
        'Allow using your own browser through the Melete extension (clicks and typing need your approval)?',
        false,
      );
    }
    if (!address || !code) throw new Error('An address and a code are both needed.');
    const config = await pair({
      address,
      code,
      name: name || defaultName(),
      capabilities,
      folders,
    });
    say(`Paired as "${config.name}". Kept in ${configPath()} (only you can read it).`);
    showSettings(config.capabilities, config.folders);
    return config;
  } finally {
    prompt?.close();
  }
}

async function connect() {
  const config = await readConfig();
  if (!config) throw new Error('This computer is not paired yet. Run: melete-device pair');
  const agent = new DeviceAgent(config);
  const stop = () => {
    say('Disconnecting. Run melete-device again to reconnect.');
    agent.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  say(`Every request is shown here and written to ${logPath()}. Press Ctrl+C to disconnect.`);
  const outcome = await agent.run();
  if (outcome === 'revoked') {
    await forgetConfig();
    say('The token on this computer was deleted. Run melete-device pair to connect again.');
    process.exitCode = 2;
  }
}

async function edit(
  change: (config: NonNullable<Awaited<ReturnType<typeof readConfig>>>) => Promise<void>,
) {
  const config = await readConfig();
  if (!config) throw new Error('This computer is not paired yet. Run: melete-device pair');
  await change(config);
  await writeConfig(config);
  showSettings(config.capabilities, config.folders);
  say('A running companion tells Melete within a few seconds.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command, ...args] = options.rest;
  switch (command) {
    case undefined:
    case 'start':
      if (!(await readConfig())) await pairCommand(options);
      return connect();
    case 'pair':
      await pairCommand(options);
      return options.flags.has('no-start') ? undefined : connect();
    case 'status': {
      const config = await readConfig();
      if (!config) return say(`Not paired. Settings would be kept in ${configDir()}.`);
      say(`"${config.name}" is paired with ${config.api}`);
      showSettings(config.capabilities, config.folders);
      return;
    }
    case 'folders':
      if (args[0] === 'add' && args[1])
        return edit(async (config) => {
          config.folders.push(await folderFrom(args[1] as string, config.folders));
        });
      if (args[0] === 'remove' && args[1])
        return edit(async (config) => {
          config.folders = config.folders.filter((folder) => folder.name !== args[1]);
        });
      return edit(async () => {});
    case 'allow':
    case 'deny':
      return edit(async (config) => {
        const name = args[0];
        if (!name || !(CAPABILITY_NAMES as readonly string[]).includes(name))
          throw new Error(`Say which: ${CAPABILITY_NAMES.join(', ')}`);
        config.capabilities[name as keyof Capabilities] = command === 'allow';
      });
    case 'browser':
      if (args[0] === 'install') {
        const written = await installHost({
          extensionId: options.flags.get('extension-id')?.at(-1) ?? EXTENSION_ID,
        });
        say('The Melete extension can now reach this companion. Written:');
        for (const line of written) say(`  ${line}`);
        say('Load the extension from packages/device/extension (chrome://extensions → Developer');
        say('mode → Load unpacked), then switch it on from its toolbar button.');
        return;
      }
      say('Usage: melete-device browser install [--extension-id <id>]');
      process.exitCode = 1;
      return;
    case 'browser-host':
      // Standard output belongs to the browser here: nothing else may be printed.
      return hostMain(await readConfig().catch(() => null));
    case 'forget':
      await forgetConfig();
      return say('The token on this computer was deleted. Revoke it in Settings → Devices too.');
    default:
      say(
        'Usage: melete-device [pair|status|folders [add <path>|remove <name>]|allow <what>|deny <what>|forget]',
      );
      process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
