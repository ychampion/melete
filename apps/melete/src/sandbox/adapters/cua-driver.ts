/**
 * Spike: the agent's browser driven by Cua Driver instead of the browser worker.
 *
 * `CuaDriverBrowser` turns the same semantic steps the browser worker takes
 * (open, fill by label, check, choose, submit, follow a link, read) into Cua
 * Driver tool calls over one stdio MCP connection: bind an isolated browser
 * once, then snapshot with `semantic_v2` and act on the refs it returns.
 * Every call is recorded with its time and outcome so a caller can count
 * steps and see refusals.
 *
 * `desktopCommandCalls` shows the other half of the seam: how the docker
 * computer's `DesktopCommand` would map onto Cua Driver tools if the driver
 * ran inside the sandbox image in place of the xdotool helper.
 */

import { type CuaDriverCall, CuaDriverMcp, type CuaDriverOptions } from './cua-driver-mcp.ts';
import type { DesktopCommand } from './docker.ts';

export type SemanticRef = {
  ref: string;
  role: string;
  name: string;
  value?: string | null;
  states?: string[];
  actions?: string[];
};

export class CuaStepRefused extends Error {
  override readonly name = 'CuaStepRefused';
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
  ) {
    super(`${tool}: ${code}: ${message}`);
  }
}

type Json = Record<string, unknown>;

/** A refusal arrives as a successful MCP result whose text starts with `refused (code)`. */
function refusalOf(call: CuaDriverCall): { code: string; message: string } | null {
  const structured = call.result as Json | null;
  const status = typeof structured === 'object' && structured ? structured.status : undefined;
  if (status === 'refused' || status === 'error') {
    const refusal = (structured?.refusal ?? structured?.error ?? {}) as Json;
    return {
      code: String(refusal.code ?? status),
      message: String(refusal.message ?? call.text),
    };
  }
  const match = /^refused \(([a-z_]+)\): (.*)$/s.exec(call.text.trim());
  if (match) return { code: match[1] ?? 'refused', message: match[2] ?? '' };
  if (!call.ok) return { code: 'tool_error', message: call.text };
  return null;
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();

export class CuaDriverBrowser {
  readonly mcp: CuaDriverMcp;
  private target = '';
  private tab = '';
  pid = 0;
  private refs: SemanticRef[] = [];
  private outline = '';
  private omittedOffscreen = 0;
  /** Choices made while resolving a step, for the record. */
  readonly notes: string[] = [];

  constructor(
    options: CuaDriverOptions,
    private readonly settings: {
      session: string;
      /** `foreground` where nothing else uses the browser's window, as inside a sandbox. */
      delivery: 'background' | 'foreground';
    },
  ) {
    this.mcp = new CuaDriverMcp(options);
  }

  get calls(): readonly CuaDriverCall[] {
    return this.mcp.calls;
  }

  private async call(tool: string, args: Json, timeoutMs?: number): Promise<Json> {
    const call = await this.mcp.call(tool, { session: this.settings.session, ...args }, timeoutMs);
    const refused = refusalOf(call);
    if (refused) throw new CuaStepRefused(tool, refused.code, refused.message.slice(0, 300));
    return (typeof call.result === 'object' && call.result ? call.result : {}) as Json;
  }

  /** Launch a driver-owned browser on a throwaway profile and bind its one tab. */
  async start(): Promise<void> {
    await this.mcp.start();
    const prepared = await this.call(
      'browser_prepare',
      { allow_launch: true, profile: { mode: 'isolated_new' } },
      120_000,
    );
    const pid = Number(prepared.prepared_pid ?? prepared.pid);
    if (!Number.isInteger(pid) || pid <= 0)
      throw new CuaStepRefused('browser_prepare', 'no_pid', JSON.stringify(prepared).slice(0, 300));
    this.pid = pid;
    let windowId: number | undefined;
    for (let attempt = 0; attempt < 20 && windowId === undefined; attempt++) {
      const listed = await this.call('list_windows', { pid });
      const windows = (listed.windows ?? []) as Json[];
      const own = windows.find((window) => Number(window.pid) === pid) ?? windows[0];
      if (own) windowId = Number(own.window_id ?? own.id);
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (windowId === undefined) throw new CuaStepRefused('list_windows', 'no_window', `pid ${pid}`);
    const bound = await this.call('get_browser_state', { pid, window_id: windowId });
    const tabs = (bound.tabs ?? []) as Json[];
    this.target = String(bound.target_id ?? '');
    this.tab = String(bound.tab_id ?? bound.selected_tab_id ?? tabs[0]?.tab_id ?? '');
    if (!this.target || !this.tab)
      throw new CuaStepRefused(
        'get_browser_state',
        'no_binding',
        JSON.stringify(bound).slice(0, 300),
      );
  }

  private get at(): Json {
    return { target_id: this.target, tab_id: this.tab };
  }

  async open(url: string): Promise<void> {
    await this.call('browser_navigate', { ...this.at, url }, 60_000);
    // Navigation can answer while a blocking script still holds the parser; look
    // again, as an agent would, until the page shows more than its root.
    for (let look = 0; look < 10; look++) {
      const refs = await this.snapshot();
      if (refs.some((ref) => ref.role !== 'rootwebarea')) return;
      if (look === 0) this.notes.push('page was empty at first look');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** A whole ranked snapshot: follows continuations until the driver says it is complete. */
  async snapshot(query?: string): Promise<SemanticRef[]> {
    const refs: SemanticRef[] = [];
    let outline = '';
    let continuation: string | undefined;
    let offscreen = 0;
    for (let page = 0; page < 6; page++) {
      const result = await this.call('get_browser_state', {
        ...this.at,
        snapshot_format: 'semantic_v2',
        ...(continuation ? { continuation } : query ? { query } : {}),
      });
      refs.push(...((result.refs ?? []) as SemanticRef[]));
      refs.push(
        ...((result.content_refs ?? []) as SemanticRef[]).map((ref) => ({ ...ref, actions: [] })),
      );
      const o = result.outline;
      outline += typeof o === 'string' ? `${o}\n` : o ? `${JSON.stringify(o)}\n` : '';
      const snapshot = (result.snapshot ?? {}) as Json;
      offscreen = Number((snapshot.omitted as Json | undefined)?.offscreen ?? 0);
      continuation = typeof snapshot.continuation === 'string' ? snapshot.continuation : undefined;
      if (snapshot.complete !== false || !continuation) break;
    }
    this.refs = refs;
    this.outline = outline;
    this.omittedOffscreen = offscreen;
    return refs;
  }

  /**
   * The ref for a control, as an agent reading the snapshot would pick it: the
   * exact accessible name (the first, when a page repeats a name, such as a
   * picture link and a title link to the same place), else the one name that
   * contains it, else the only control of that role on the page.
   */
  private async find(roles: readonly string[], label: string): Promise<SemanticRef> {
    const wanted = norm(label);
    for (let scroll = 0; scroll <= 4; scroll++) {
      const candidates = this.refs.filter(
        (ref) => roles.includes(ref.role) && (ref.actions ?? []).length > 0,
      );
      const exact = candidates.filter((ref) => norm(ref.name ?? '') === wanted);
      const loose = candidates.filter((ref) => norm(ref.name ?? '').includes(wanted));
      const found =
        exact[0] ??
        (loose.length === 1 ? loose[0] : undefined) ??
        (loose.length === 0 && candidates.length === 1 ? candidates[0] : undefined);
      if (found) {
        if (exact.length > 1) this.notes.push(`picked the first of ${exact.length} "${label}"`);
        if (!exact.length && !loose.length) this.notes.push(`took the only ${found.role}`);
        return found;
      }
      if (loose.length > 1)
        throw new CuaStepRefused('find', 'ambiguous_control', `${roles.join('|')} "${label}"`);
      // Offscreen controls are left out of a snapshot; scroll only when some were.
      if (scroll === 4 || this.omittedOffscreen === 0) break;
      // Offscreen controls are left out of a snapshot; scroll and look again.
      await this.call('browser_pointer', {
        ...this.at,
        action: 'scroll',
        x: 200,
        y: 200,
        delta_y: 500,
        delivery_mode: this.settings.delivery,
      });
      await this.snapshot();
    }
    throw new CuaStepRefused(
      'find',
      'control_not_found',
      `${roles.join('|')} "${label}" (offscreen omitted: ${this.omittedOffscreen})`,
    );
  }

  async fill(label: string, value: string): Promise<void> {
    const ref = await this.find(['textbox', 'searchbox', 'spinbutton'], label);
    // Focus by clicking only where the ref offers a click; typing focuses an editable itself.
    if ((ref.actions ?? []).includes('click'))
      await this.call('browser_click', {
        ...this.at,
        ref: ref.ref,
        delivery_mode: this.settings.delivery,
      });
    // Replacing selects the old content first, which some input types refuse; an
    // empty field needs no replacing.
    await this.call('browser_type', {
      ...this.at,
      ref: ref.ref,
      text: value,
      ...(ref.value ? { replace: true } : {}),
    });
    await this.snapshot();
  }

  async check(role: 'radio' | 'checkbox', label: string): Promise<void> {
    const ref = await this.find([role], label);
    await this.call('browser_click', {
      ...this.at,
      ref: ref.ref,
      delivery_mode: this.settings.delivery,
    });
    await this.snapshot();
  }

  /** There is no typed select tool: click an option ref if the snapshot lists one, else the keyboard. */
  async select(label: string, option: string): Promise<void> {
    const box = await this.find(['combobox', 'listbox'], label);
    const optionRef = this.refs.find(
      (ref) =>
        ref.role === 'option' &&
        norm(ref.name) === norm(option) &&
        (ref.actions ?? []).includes('click'),
    );
    if (optionRef) {
      await this.call('browser_click', {
        ...this.at,
        ref: optionRef.ref,
        delivery_mode: this.settings.delivery,
      });
    } else {
      await this.call('browser_click', {
        ...this.at,
        ref: box.ref,
        delivery_mode: this.settings.delivery,
      });
      await this.call('browser_type', {
        ...this.at,
        ref: box.ref,
        text: option,
        mode: 'keystrokes',
      });
    }
    await this.snapshot();
  }

  async click(roles: readonly string[], name: string): Promise<void> {
    const ref = await this.find(roles, name);
    await this.call(
      'browser_click',
      { ...this.at, ref: ref.ref, delivery_mode: this.settings.delivery },
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await this.snapshot();
  }

  valueOf(roles: readonly string[], label: string): string | undefined {
    const wanted = norm(label);
    const ref = this.refs.find(
      (r) => roles.includes(r.role) && norm(r.name ?? '').includes(wanted),
    );
    return ref?.value ?? undefined;
  }

  /** The latest refs in one line each, for a failure record. */
  refSummary(max = 40): string {
    return this.refs
      .slice(0, max)
      .map(
        (r) =>
          `${r.ref} ${r.role} ${JSON.stringify(r.name ?? '')} [${(r.actions ?? []).join(',')}]${r.value ? ` = ${r.value}` : ''}`,
      )
      .join('\n');
  }

  /** What the page shows: the snapshot outline plus every ref's name and value. */
  text(): string {
    return `${this.outline}\n${this.refs.map((ref) => `${ref.role} ${ref.name ?? ''} ${ref.value ?? ''}`).join('\n')}`;
  }

  async stop(): Promise<void> {
    try {
      await this.mcp.call('end_session', { session: this.settings.session }, 15_000);
    } catch {
      // The driver is closed next either way.
    }
    await this.mcp.close();
  }
}

/**
 * The docker computer's desktop commands as Cua Driver tool calls on a desktop
 * target, for a sandbox image that ships the driver: one exec per call, the
 * same as the xdotool helper today, so no socket leaves the sandbox.
 */
export function desktopCommandCalls(command: DesktopCommand): { tool: string; args: Json }[] {
  const desktop = {
    target: { kind: 'desktop', display_id: 'primary' },
    delivery_mode: 'foreground',
  };
  switch (command.kind) {
    case 'screenshot':
    case 'info':
      return [{ tool: 'get_desktop_state', args: {} }];
    case 'open':
      return [{ tool: 'launch_app', args: { urls: [command.url] } }];
    case 'click':
      return [
        {
          tool: 'click',
          args: {
            ...desktop,
            x: command.x,
            y: command.y,
            button: command.button === 3 ? 'right' : command.button === 2 ? 'middle' : 'left',
            count: command.count,
          },
        },
      ];
    case 'type':
      return [{ tool: 'type_text', args: { ...desktop, text: command.text } }];
    case 'key':
      return command.keys.map((key) => ({
        tool: 'hotkey',
        args: { ...desktop, keys: key.split('+') },
      }));
    case 'scroll':
      return [
        {
          tool: 'scroll',
          args: {
            ...desktop,
            x: command.x,
            y: command.y,
            direction: command.dy > 0 ? 'down' : 'up',
            amount: Math.abs(command.dy),
          },
        },
      ];
    case 'input':
      // A person's live-view input stays on the existing path: it is not the agent's.
      return [];
  }
}
