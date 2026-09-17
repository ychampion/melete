import { createHash, randomUUID } from 'node:crypto';
import type { CDPSession, ElementHandle, Locator, Page } from 'playwright';
import { z } from 'zod';
import {
  type BrowserEgress,
  BrowserNetworkError,
  type BrowserNetworkOptions,
  BrowserRedirect,
  createBrowserEgress,
} from './egress.ts';
import { BrowserLive } from './live.ts';
import { redactSecretText } from './redact.ts';
import { BrowserFault, BrowserSessions, type BrowserSessionsOptions } from './sessions.ts';
import { isSensitiveControl, type VisibleSchema } from './visible.ts';

// These declarations describe only code evaluated inside Chromium. They do not add DOM globals
// to the Bun service's type environment (whose streams include Bun-specific methods).
type BrowserElement = {
  tagName: string;
  type: string;
  name: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  checked: boolean;
  autocomplete: string;
  validity: { valid: boolean };
  form: BrowserForm | null;
  options: Array<{ label: string; value: string; disabled: boolean }>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getClientRects(): { length: number };
  focus(): void;
  select(): void;
  dispatchEvent(event: Event): boolean;
};
type BrowserForm = { elements: BrowserElement[]; method: string; enctype: string; action: string };
declare const document: {
  forms: BrowserForm[];
  querySelectorAll(selector: string): BrowserElement[];
};
declare const location: { href: string };
declare const FormData: {
  new (
    form: BrowserForm,
    submitter: BrowserElement,
  ): { entries(): IterableIterator<[string, string | Blob]> };
};

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return typeof value === 'string' ? value.trim() : value;
}
const hash = (value: unknown) => digest(JSON.stringify(sorted(value)));

export const browserSubmitIntent = z.strictObject({
  url: z.string().url(),
  method: z.literal('POST'),
  role: z.literal('button'),
  name: z.string().min(1),
  form_hash: z.string().regex(/^[a-f0-9]{64}$/),
  body_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fields: z.record(z.string(), z.string()),
});
export type BrowserSubmitIntent = z.infer<typeof browserSubmitIntent>;
const operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), url: z.string().url() }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({
    kind: z.literal('fill'),
    label: z.string().min(1).max(240),
    value: z.string().max(16_000),
  }),
  z.strictObject({
    kind: z.literal('click'),
    role: z.string().max(40),
    name: z.string().min(1).max(240),
  }),
  z.strictObject({
    kind: z.literal('select'),
    label: z.string().min(1).max(240),
    value: z.string().max(2000),
  }),
  z.strictObject({
    kind: z.literal('read'),
    selector: z.string().max(500).optional(),
    role: z.string().max(40).optional(),
    name: z.string().max(240).optional(),
  }),
  z.strictObject({ kind: z.literal('submit'), intent: browserSubmitIntent }),
]);
export const browserCommand = z.strictObject({
  session_id: z.string(),
  job_id: z.string(),
  control_epoch: z.number().int().nonnegative(),
  operation,
});
export type BrowserCommand = z.infer<typeof browserCommand>;
export type BrowserObservation = {
  id: string;
  url: string;
  tree: string;
  /** Empty for the first observation after a person hands back control. */
  screenshot: string;
  schema: VisibleSchema;
};
export type BrowserCommandResult = {
  session_id: string;
  control_epoch: number;
  observation?: BrowserObservation;
  result?: Record<string, unknown>;
};

/** All browser input is dispatched here, below the broker and independent of a model's cooperation. */
export class BrowserController {
  readonly sessions: BrowserSessions;
  readonly live: BrowserLive;
  private network?: BrowserEgress;
  private cdp?: CDPSession;
  private dialogRevision = 0;
  private pageId?: string;
  private replacingPage = false;
  /** Set at handback; cleared only by an observation that completes. */
  private humanJustLeft = false;
  readonly metrics = { observations: 0, dispatched_inputs: 0, refused_inputs: 0 };

  constructor(options: BrowserSessionsOptions & { network?: BrowserNetworkOptions }) {
    this.sessions = new BrowserSessions({
      ...options,
      install: async (context, policy) => {
        await this.network?.close();
        this.network = createBrowserEgress(policy, options.network);
        await this.network.install(context);
        this.cdp = undefined;
        this.pageId = undefined;
        // Additional windows cannot become an unobserved channel outside the single-page lease,
        // except one popup at a time that a person in control opens and sees in their live view.
        context.on('page', (page) => {
          if (this.replacingPage || !this.sessions.page || page === this.sessions.page) return;
          if (!this.live.popup(page)) void page.close();
        });
      },
    });
    this.live = new BrowserLive(this);
    this.sessions.onControl((change) => {
      if (change === 'handback') this.humanJustLeft = true;
      return undefined;
    });
  }

  guard(): BrowserEgress | undefined {
    return this.network;
  }

  adoptPage(page: Page): void {
    this.sessions.page = page;
    page.setDefaultTimeout(2500);
    this.cdp = undefined;
  }

  private async attach(): Promise<{ page: Page; cdp: CDPSession }> {
    const page = this.sessions.page;
    const context = this.sessions.context;
    const session = this.sessions.session;
    if (!page || !context || !session) throw new BrowserFault('session_not_found');
    if (!this.cdp || this.pageId !== session.id) {
      this.cdp = await context.newCDPSession(page);
      this.pageId = session.id;
      page.on('dialog', (dialog) => {
        this.dialogRevision++;
        // Dismissal is safe; accepting an unplanned dialog could commit an effect.
        void dialog.dismiss();
      });
    }
    return { page, cdp: this.cdp };
  }

  private async unique(locator: Locator): Promise<ElementHandle<BrowserElement>> {
    const visible = locator.filter({ visible: true });
    const count = await visible.count();
    if (count !== 1) throw new BrowserFault(count ? 'ambiguous_control' : 'control_not_found');
    const handle = await visible.elementHandle();
    if (!handle) throw new BrowserFault('control_not_found');
    return handle as unknown as ElementHandle<BrowserElement>;
  }

  private role(page: Page, role: string, name?: string): Locator {
    // Playwright validates supported roles; no CSS or script is accepted by input tools.
    return page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true });
  }

  private input<T>(command: BrowserCommand, dispatch: () => Promise<T>): Promise<T> {
    try {
      return this.sessions.dispatchInput(command.session_id, command.control_epoch, () => {
        this.metrics.dispatched_inputs++;
        return dispatch();
      });
    } catch (error) {
      this.metrics.refused_inputs++;
      throw error;
    }
  }

  private async navigate(command: BrowserCommand, target: string): Promise<void> {
    if (!this.network || !this.sessions.context) throw new BrowserFault('worker_unavailable');
    let url = target;
    for (let hop = 0; hop < 6; hop++) {
      const page = this.sessions.page;
      if (!page) throw new BrowserFault('session_not_found');
      try {
        await this.network.run(
          'navigate',
          () =>
            this.input(command, () =>
              page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
            ),
          undefined,
          () => this.sessions.checkInput(command.session_id, command.control_epoch),
        );
        return;
      } catch (error) {
        if (!(error instanceof BrowserRedirect) || error.after_commit) throw error;
        url = error.target_url;
        await this.replacePage(command);
      }
    }
    throw new BrowserFault('redirect_limit');
  }

  private async replacePage(command: BrowserCommand) {
    const context = this.sessions.context;
    if (!context) throw new BrowserFault('session_not_found');
    this.replacingPage = true;
    try {
      const previous = this.sessions.page;
      this.sessions.page = await this.input(command, () => context.newPage());
      this.sessions.page.setDefaultTimeout(2500);
      this.cdp = undefined;
      await previous?.close();
    } finally {
      this.replacingPage = false;
    }
  }

  private async schema(page: Page, cdp: CDPSession): Promise<VisibleSchema> {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const roles = new Set([
      'textbox',
      'combobox',
      'checkbox',
      'radio',
      'button',
      'link',
      'spinbutton',
    ]);
    const schema: VisibleSchema = [];
    for (const node of nodes) {
      const role = String(node.role?.value ?? '');
      if (node.ignored || !roles.has(role)) continue;
      const label = String(node.name?.value ?? '');
      const locator = this.role(page, role, label).filter({ visible: true });
      if (!(await locator.count())) continue;
      let sensitive = isSensitiveControl({ label, role, sensitive: false, required: false });
      const first = locator.first();
      sensitive ||= await first.evaluate(
        (element) =>
          element.getAttribute('type') === 'password' ||
          /password|one-time-code|webauthn|cc-number|cc-csc/i.test(
            element.getAttribute('autocomplete') ?? '',
          ),
      );
      schema.push({
        label,
        role,
        sensitive,
        required: Boolean(
          node.properties?.find((property) => property.name === 'required')?.value.value,
        ),
      });
      // Refuse oversized pages before issuing locator queries for the rest of the AX tree.
      if (schema.length > 128) throw new BrowserFault('schema_too_large');
    }
    return schema;
  }

  private async formIntent(page: Page, name: string): Promise<BrowserSubmitIntent> {
    const button = await this.unique(this.role(page, 'button', name));
    const data = await button.evaluate((element) => {
      if (
        !['BUTTON', 'INPUT'].includes(element.tagName) ||
        element.type !== 'submit' ||
        !element.form
      )
        return null;
      const form = element.form;
      const controls = Array.from(form.elements).filter((field): field is BrowserElement =>
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(field.tagName),
      );
      const sensitive = controls.some(
        (field) =>
          field.type === 'password' ||
          /password|one-time-code|webauthn|cc-number|cc-csc/i.test(field.autocomplete) ||
          /password|passcode|otp|verification.code|security.code|authenticator/i.test(
            `${field.name} ${field.getAttribute('aria-label') ?? ''}`,
          ),
      );
      const method = (element.getAttribute('formmethod') ?? form.method).toUpperCase();
      const enctype = element.getAttribute('formenctype') ?? form.enctype;
      if (sensitive || method !== 'POST' || enctype !== 'application/x-www-form-urlencoded')
        return null;
      if (controls.some((field) => !field.validity.valid)) return null;
      const formData = new FormData(form, element);
      const pairs: Array<[string, string]> = [];
      for (const [key, value] of formData.entries()) {
        if (typeof key !== 'string' || typeof value !== 'string' || pairs.length >= 128)
          return null;
        // Native HTML form submission normalizes line breaks before URL encoding.
        pairs.push([key.replace(/\r?\n|\r/g, '\r\n'), value.replace(/\r?\n|\r/g, '\r\n')]);
      }
      const url = new URL(element.getAttribute('formaction') ?? form.action, location.href).href;
      return { url, pairs, page_url: location.href };
    });
    if (!data) throw new BrowserFault('unsupported_or_incomplete_form');
    // Construct both approval fields and exact wire bytes in the worker realm. A page
    // can replace its own URLSearchParams, and hidden fields can choose a recipient.
    const fields: Record<string, string> = Object.create(null);
    for (const [key, value] of data.pairs) {
      // JSON schema parsers discard this key, so it cannot cross approval intact.
      if (key === '__proto__' || Object.hasOwn(fields, key))
        throw new BrowserFault('unsupported_or_incomplete_form');
      fields[key] = value;
    }
    const body = new URLSearchParams(data.pairs).toString();
    if (Buffer.byteLength(body) > 64 * 1024)
      throw new BrowserFault('unsupported_or_incomplete_form');
    return {
      url: data.url,
      method: 'POST',
      role: 'button',
      name,
      fields,
      body_sha256: digest(body),
      form_hash: hash(data),
    };
  }

  private async observe(command: BrowserCommand): Promise<BrowserCommandResult> {
    const session = this.sessions.requireSession(command.session_id, command.job_id);
    if (session.control !== 'automation') throw new BrowserFault('human_control');
    const epoch = session.control_epoch;
    // What a person typed or was shown can still be on the page they hand back: the first
    // observation afterwards carries no picture and a redacted tree, and still refuses below.
    const handedBack = this.humanJustLeft;
    const { page, cdp } = await this.attach();
    const schema = await this.schema(page, cdp);
    // No screenshot, tree, episode, recipe or artifact is recorded while authentication fields are visible.
    if (schema.some((control) => control.sensitive))
      throw new BrowserFault('sensitive_input_require_takeover');
    const snapshot = await page.locator('body').ariaSnapshot();
    if (snapshot.length > 128_000) throw new BrowserFault('observation_too_large');
    const tree = handedBack ? redactSecretText(snapshot) : snapshot;
    const screenshot = handedBack
      ? ''
      : (
          await cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width: 1024, height: 768, scale: 0.5 },
            captureBeyondViewport: false,
          })
        ).data;
    const intents: BrowserSubmitIntent[] = [];
    for (const control of schema.filter((control) => control.role === 'button')) {
      try {
        intents.push(await this.formIntent(page, control.label));
      } catch (error) {
        if (!(error instanceof BrowserFault)) throw error;
      }
    }
    this.sessions.observed(session.id, epoch);
    if (handedBack) this.humanJustLeft = false;
    this.metrics.observations++;
    return {
      session_id: session.id,
      control_epoch: epoch,
      observation: {
        id: `obs_${randomUUID()}`,
        url: page.url(),
        schema,
        tree,
        screenshot,
      },
      result: { submit_intents: intents },
    };
  }

  private async transition(page: Page, cdp: CDPSession): Promise<string> {
    return hash({
      url: page.url(),
      dialog: this.dialogRevision,
      schema: await this.schema(page, cdp),
      state: await page.evaluate(() => ({
        controls: Array.from(document.querySelectorAll('input,textarea,select,button,[role]'))
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({
            tag: element.tagName,
            role: element.getAttribute('role'),
            name: element.getAttribute('aria-label'),
            disabled: element.hasAttribute('disabled'),
            required: element.hasAttribute('required'),
            checked: element.tagName === 'INPUT' ? element.checked : undefined,
          })),
        forms: Array.from(document.forms).map((form) => ({
          action: form.action,
          valid: Array.from(form.elements).every(
            (element) => !('validity' in element) || (element as BrowserElement).validity.valid,
          ),
        })),
      })),
    });
  }

  async command(input: unknown): Promise<BrowserCommandResult> {
    const command = browserCommand.parse(input);
    let commitStarted = false;
    return this.sessions
      .exclusive(async () => {
        const session = this.sessions.requireSession(command.session_id, command.job_id);
        if (command.operation.kind === 'observe') return this.observe(command);
        let { page, cdp } = await this.attach();
        if (!this.network) throw new BrowserFault('worker_unavailable');
        if (command.operation.kind === 'read') {
          this.sessions.checkInput(command.session_id, command.control_epoch);
          if ((await this.schema(page, cdp)).some((control) => control.sensitive))
            throw new BrowserFault('sensitive_input_require_takeover');
          const query = command.operation;
          const handle = await this.unique(
            query.selector
              ? page.locator(query.selector)
              : this.role(page, query.role ?? 'document', query.name),
          );
          const text = (await handle.textContent())?.slice(0, 16_000) ?? '';
          this.sessions.checkInput(command.session_id, command.control_epoch);
          return { session_id: session.id, control_epoch: session.control_epoch, result: { text } };
        }
        // Even a caller that skips planning checks reaches this controller gate before it can act.
        this.sessions.checkInput(command.session_id, command.control_epoch);
        const before = await this.transition(page, cdp);
        const action = command.operation;
        if (action.kind === 'open') {
          await this.navigate(command, action.url);
        } else if (action.kind === 'fill') {
          const handle = await this.unique(page.getByLabel(action.label, { exact: true }));
          const safe = await handle.evaluate(
            (element) =>
              ((element.tagName === 'INPUT' &&
                ['text', 'email', 'search', 'tel', 'url'].includes(element.type)) ||
                element.tagName === 'TEXTAREA') &&
              !element.readOnly &&
              !element.disabled &&
              !/password|one-time-code|webauthn|cc-number|cc-csc/i.test(element.autocomplete),
          );
          if (
            !safe ||
            isSensitiveControl({
              label: action.label,
              role: 'textbox',
              sensitive: false,
              required: false,
            })
          )
            throw new BrowserFault('sensitive_input_require_takeover');
          await this.network.run('reversible', async () => {
            await this.input(command, () =>
              handle.evaluate((element) => {
                element.focus();
                element.select();
              }),
            );
            if (action.value)
              await this.input(command, () => cdp.send('Input.insertText', { text: action.value }));
            else {
              await this.input(command, () =>
                cdp.send('Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  key: 'Backspace',
                  windowsVirtualKeyCode: 8,
                }),
              );
              await this.input(command, () =>
                cdp.send('Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: 'Backspace',
                  windowsVirtualKeyCode: 8,
                }),
              );
            }
          });
        } else if (action.kind === 'select') {
          const handle = await this.unique(page.getByLabel(action.label, { exact: true }));
          if (
            isSensitiveControl({
              label: action.label,
              role: 'combobox',
              sensitive: false,
              required: false,
            })
          )
            throw new BrowserFault('sensitive_input_require_takeover');
          await this.network.run('reversible', () =>
            this.input(command, () =>
              handle.evaluate((element, value) => {
                if (element.tagName !== 'SELECT' || element.disabled)
                  throw new Error('not_selectable');
                const options = Array.from(element.options).filter(
                  (option) => option.label === value || option.value === value,
                );
                const option = options[0];
                if (options.length !== 1 || !option || option.disabled)
                  throw new Error('ambiguous_option');
                element.value = option.value;
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
              }, action.value),
            ),
          );
        } else {
          const target = action.kind === 'submit' ? action.intent : action;
          const handle = await this.unique(this.role(page, target.role, target.name));
          if (action.kind === 'click') {
            const commitControl = await handle.evaluate(
              (element) =>
                element.tagName === 'A' ||
                (['BUTTON', 'INPUT'].includes(element.tagName) && element.type === 'submit'),
            );
            if (commitControl) throw new BrowserFault('commit_requires_submit');
          } else if (hash(await this.formIntent(page, target.name)) !== hash(action.intent)) {
            throw new BrowserFault('submit_intent_changed');
          }
          const box = await handle.boundingBox();
          if (!box || !(await handle.isEnabled())) throw new BrowserFault('control_not_available');
          const click = async () => {
            await this.input(command, () =>
              cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                x: box.x + box.width / 2,
                y: box.y + box.height / 2,
              }),
            );
            await this.input(command, () =>
              cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                button: 'left',
                clickCount: 1,
                x: box.x + box.width / 2,
                y: box.y + box.height / 2,
              }),
            );
          };
          if (action.kind === 'submit') {
            commitStarted = true;
            try {
              await this.network.run(
                'commit',
                async () => {
                  const navigation = page.waitForEvent('framenavigated', {
                    predicate: (frame) => frame === page.mainFrame(),
                    timeout: 5000,
                  });
                  const response = page.waitForResponse(
                    (response) => response.request().method() === 'POST',
                    { timeout: 5000 },
                  );
                  await Promise.all([click(), response, navigation]);
                  await page.waitForLoadState('domcontentloaded');
                },
                action.intent,
                () => this.sessions.checkInput(command.session_id, command.control_epoch),
              );
            } catch (error) {
              if (!(error instanceof BrowserRedirect) || !error.after_commit) throw error;
              await this.replacePage(command);
              await this.navigate(command, error.target_url);
            }
          } else await this.network.run('reversible', click);
        }
        ({ page, cdp } = await this.attach());
        const after = await this.transition(page, cdp);
        if (before !== after || action.kind === 'open' || action.kind === 'submit')
          return this.observe(command);
        return {
          session_id: session.id,
          control_epoch: session.control_epoch,
          result: { changed: false },
        };
      })
      .catch((error) => {
        if (commitStarted && this.network?.commitDispatched)
          throw new Error('browser_commit_unknown');
        if (error instanceof BrowserNetworkError) throw new BrowserFault(error.code);
        throw error;
      });
  }
}
