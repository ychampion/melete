/**
 * Teaching by showing. A person who chooses "Show Melete how" takes the browser over as any
 * takeover does, under the same control epoch, and while they hold it this module keeps a step
 * log of what they do with their own input: each page they reach, each control they press by its
 * accessible role and name, each field they type into by its label with the value left out, and
 * each file they ask to download. Nothing else is kept: no picture, no page text beyond those
 * names, no value typed. A password, one-time-code or card field leaves no step at all, not even
 * its length.
 *
 * The log belongs to the epoch it was started under (`BrowserSessions.teaching`) and leaves the
 * worker once, in the response to that epoch's handback; any other change of control seals it
 * empty-handed. The service turns it into a record for the turn (`routes.ts`).
 */
import type { CDPSession, Page } from 'playwright';
import { z } from 'zod';
import { hostOf, type LiveInput } from './live-protocol.ts';
import { EMAIL, handbackLabel, handbackUrl, REDACTED, teachingLabel } from './redact.ts';
import { attributeWords, isSensitiveControl, sensitiveName } from './visible.ts';

/** The most steps one demonstration keeps; later ones are counted as cut off, never kept. */
export const TEACH_STEP_LIMIT = 200;
const NAME_LIMIT = 120;
/** How long one look at the page under the person's pointer may hold their input back. */
const PROBE_MS = 750;

const name = z.string().max(NAME_LIMIT);
export const taughtStep = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), url: z.string().max(2048), title: name }),
  z.strictObject({ kind: z.literal('click'), role: z.string().max(40), name, title: name }),
  z.strictObject({ kind: z.literal('fill'), label: name, value: z.string().max(NAME_LIMIT + 2) }),
  z.strictObject({ kind: z.literal('press'), key: z.enum(['Enter']) }),
  z.strictObject({ kind: z.literal('download'), file: name, type: z.string().max(100) }),
]);
export type TaughtStep = z.infer<typeof taughtStep>;
/** What a demonstration hands back: its steps in order, and whether the cap cut it short. */
export const shownSteps = z.strictObject({
  steps: z.array(taughtStep).max(TEACH_STEP_LIMIT),
  truncated: z.boolean(),
});
export type ShownSteps = z.infer<typeof shownSteps>;

/** What the browser says about one element: its accessible role and name, and a few attributes. */
export type ElementFacts = {
  role: string;
  name: string;
  /** Lower-case element name: `input`, `a`, `button`. */
  tag: string;
  /** `type`, `autocomplete`, `name`, `id`, `inputmode`, `placeholder`, lower-case keys. */
  attributes: Record<string, string>;
  /** Tells one field from the next while the person types. */
  node?: number;
};

/** Roles a person types into. A click into one is not a step; what they type is. */
const TYPED_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
/** Roles a press means something on, the nearest of which names a click. */
const PRESSED_ROLES = new Set([
  'link',
  'button',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'listbox',
  'treeitem',
  'textbox',
  'searchbox',
  'spinbutton',
]);
/** Roles a value is picked in, which a card's expiry or a security question can be. */
const CHOSEN_ROLES = new Set(['combobox', 'listbox', 'option']);
const SECRET_AUTOCOMPLETE =
  /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:$|\s)/i;
/** A query parameter whose name says it carries who someone is or what lets them in. */
const IDENTIFYING_KEY =
  /(?:^|\s)(?:token|session|sid|id|uid|code|key|sig|signature|auth|state|nonce|ticket|hash|secret|jwt|email|account|user|name|phone|tel|mobile|address|dob|birthday|birthdate|zip|postcode)s?(?:$|\s)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A field's name or id, read as words, that says a password goes in it. */
const SECRET_WORDS = /(?:^|\s)(?:pwd|passwd|pass|passphrase)(?:$|\s)/i;
/** A label that asks for a code the person was sent ("Enter the code we texted you"), or a passphrase. */
const SENT_CODE =
  /\bcodes?\b.*\b(?:sent|texted|emailed)\b|\b(?:sent|texted|emailed)\b.*\bcodes?\b|\bpass ?phrase\b/i;
/** A query value that carries an address, an email or another query, never a plain choice. */
const NESTED_VALUE = /[@:/?&=]/;
const HAS_EMAIL = new RegExp(EMAIL.source);

const clip = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
/** A name or title the page gave, with the shapes of a secret taken out as at handback. */
const shownName = (value: string) => clip(teachingLabel(clip(value)));

/** Whether an element takes typing. */
export function typedInto(facts: ElementFacts): boolean {
  return (
    TYPED_ROLES.has(facts.role) ||
    facts.tag === 'textarea' ||
    (facts.tag === 'input' &&
      ![
        'button',
        'submit',
        'reset',
        'checkbox',
        'radio',
        'file',
        'image',
        'range',
        'color',
      ].includes((facts.attributes.type ?? 'text').toLowerCase())) ||
    'contenteditable' in facts.attributes
  );
}

/**
 * Whether a field is one only the person fills: a password, a one-time code or a card, by its
 * type, its autocomplete hint, its name or id, or its label. Such a field leaves no step.
 */
export function secretField(facts: ElementFacts): boolean {
  const { attributes } = facts;
  if ((attributes.type ?? '').toLowerCase() === 'password') return true;
  if (SECRET_AUTOCOMPLETE.test(attributes.autocomplete ?? '')) return true;
  const named = [attributes.name, attributes.id, attributes.placeholder, attributes['aria-label']];
  if (
    named.some(
      (value) =>
        value &&
        (sensitiveName.test(attributeWords(value)) || SECRET_WORDS.test(attributeWords(value))),
    ) ||
    SENT_CODE.test(facts.name)
  )
    return true;
  return isSensitiveControl({
    label: facts.name,
    role: TYPED_ROLES.has(facts.role) ? facts.role : 'textbox',
    required: false,
    sensitive: false,
  });
}

/**
 * Where a page is, as a step keeps it: scheme, host and a path filtered as a handed-back page's
 * is, with no email address in it, and only the query parameters that look like neither an
 * identity, a token nor another address. `withQuery` false keeps no query at all.
 */
export function taughtUrl(value: string, withQuery = true): string {
  const handed = hostOf(value) ? handbackUrl(value) : '';
  if (!handed) return '';
  const { protocol, host, pathname } = new URL(handed);
  const path = pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // handbackUrl has already replaced a segment that does not decode.
      }
      return HAS_EMAIL.test(decoded) ? encodeURIComponent(REDACTED) : segment;
    })
    .join('/');
  const base = `${protocol}//${host}${path}`;
  const kept = new URLSearchParams();
  for (const [key, parameter] of withQuery ? new URL(value).searchParams : []) {
    const words = attributeWords(key);
    if (
      !parameter ||
      key.length > 40 ||
      parameter.length > 40 ||
      IDENTIFYING_KEY.test(words) ||
      sensitiveName.test(words) ||
      UUID.test(parameter) ||
      NESTED_VALUE.test(parameter) ||
      /^[A-Za-z0-9]{16,}$/.test(parameter) ||
      handbackLabel(parameter) !== parameter
    )
      continue;
    kept.append(key, parameter);
  }
  const query = kept.toString();
  return query ? `${base}?${query}` : base;
}

/** The file a download response names, from its header or else its address, filtered as a name. */
export function downloadName(disposition: string | undefined, url: string): string {
  const header = disposition ?? '';
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1];
  let file = '';
  try {
    file = encoded ? decodeURIComponent(encoded) : (plain ?? '');
  } catch {
    file = plain ?? '';
  }
  if (!file)
    try {
      file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    } catch {
      file = '';
    }
  return shownName(file.replace(/^.*[\\/]/, '')) || 'a file';
}

/** The placeholder a typed value is replaced by, named after its field. */
const placeholder = (label: string) => `{${label.toLowerCase().slice(0, NAME_LIMIT) || 'text'}}`;

/** A download's media type, or nothing when the header is not one. */
const mediaType = (type: string) => {
  const kept = (type.split(';')[0] ?? '').trim().toLowerCase();
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,58}$/.test(kept) ? kept : '';
};

/**
 * A step as the service keeps it, whatever worker sent it: every name, title and address filtered
 * again, a press only ever on a role a press means something on, and a typed value only ever the
 * placeholder named after its field. Null when nothing of the step is left to keep.
 */
export function cleanStep(step: TaughtStep): TaughtStep | null {
  switch (step.kind) {
    case 'open': {
      const url = taughtUrl(step.url);
      return url ? { kind: 'open', url, title: shownName(step.title) } : null;
    }
    case 'click': {
      const label = shownName(step.name);
      return PRESSED_ROLES.has(step.role) && label
        ? { kind: 'click', role: step.role, name: label, title: shownName(step.title) }
        : null;
    }
    case 'fill': {
      const label = shownName(step.label);
      return { kind: 'fill', label, value: placeholder(label) };
    }
    case 'press':
      return { kind: 'press', key: step.key };
    case 'download':
      return {
        kind: 'download',
        file: shownName(step.file) || 'a file',
        type: mediaType(step.type),
      };
  }
}

/** One demonstration's steps, for one control epoch, capped, and sealed when it is handed over. */
export class StepLog {
  private readonly steps: TaughtStep[] = [];
  private truncated = false;
  private sealed = false;
  private lastField?: number | string;
  /** Once the person has typed, a page's query may hold what they typed, so none is kept. */
  private typed = false;

  constructor(
    readonly epoch: number,
    private readonly limit: number = TEACH_STEP_LIMIT,
  ) {}

  get size(): number {
    return this.steps.length;
  }

  opened(url: string, title: string): void {
    const shown = taughtUrl(url, !this.typed);
    if (!shown) return;
    const step: TaughtStep = { kind: 'open', url: shown, title: shownName(title) };
    // A redirect, or the same page loading again, is one place reached.
    if (this.steps.at(-1)?.kind === 'open' && !this.sealed) {
      this.steps[this.steps.length - 1] = step;
      return;
    }
    this.add(step);
  }

  clicked(facts: ElementFacts, title: string): void {
    this.lastField = undefined;
    const label = shownName(facts.name);
    if (!label) return;
    this.add({ kind: 'click', role: facts.role, name: label, title: shownName(title) });
  }

  /** The person typed something, into whatever field; what they typed is never kept. */
  typing(): void {
    this.typed = true;
  }

  /** A field typed into, once however many keys it takes; a secret field leaves nothing. */
  filled(facts: ElementFacts): void {
    if (secretField(facts)) return;
    const field = facts.node ?? facts.name;
    if (field === this.lastField) return;
    const label = shownName(facts.name || facts.attributes.placeholder || '');
    this.lastField = field;
    this.add({ kind: 'fill', label, value: placeholder(label) });
  }

  pressed(key: 'Enter'): void {
    this.lastField = undefined;
    this.add({ kind: 'press', key });
  }

  /** The person moved on from the field they were typing into. */
  left(): void {
    this.lastField = undefined;
  }

  downloaded(file: string, type: string): void {
    this.add({ kind: 'download', file, type: mediaType(type) });
  }

  /** The steps, once; nothing is added after. */
  seal(): ShownSteps {
    this.sealed = true;
    return { steps: [...this.steps], truncated: this.truncated };
  }

  private add(step: TaughtStep): void {
    if (this.sealed) return;
    if (this.steps.length >= this.limit) {
      this.truncated = true;
      return;
    }
    this.steps.push(step);
  }
}

/** What the recorder asks of the page under the person's pointer and keys. */
export type TeachProbe = {
  at(x: number, y: number): Promise<ElementFacts | undefined>;
  focused(): Promise<ElementFacts | undefined>;
  title(): Promise<string>;
};

/** The look's answer, or nothing once it fails or takes longer than `PROBE_MS`. */
const bounded = <T>(work: Promise<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), PROBE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });

/**
 * Turns one live channel's input into steps. It is called with each event just before that event
 * is dispatched, inside the epoch check, so a step is only ever taken from the person's own input
 * while they hold control. A look that fails or is slow leaves no step and never holds input back
 * for long.
 */
export class TeachRecorder {
  private typing = false;

  constructor(
    readonly log: StepLog,
    /** The probe for the page the person sees now, which a popup can change. */
    private readonly probe: () => TeachProbe | undefined,
  ) {}

  async before(event: LiveInput): Promise<void> {
    const probe = this.probe();
    if (!probe) return;
    const point =
      event.k === 'down' && event.button === 0
        ? event
        : event.k === 'touch' && event.phase === 'start'
          ? (event.points[0] ?? null)
          : undefined;
    if (point !== undefined) {
      this.typing = false;
      this.log.left();
      if (!point) return;
      const facts = await bounded(probe.at(point.x, point.y));
      // A click into a field is shown by what is typed there, and a choice in a secret one (a
      // card's expiry month) shows nothing. A button's name never makes it secret: "Sign in" is
      // a step like any other.
      if (!facts || typedInto(facts) || (CHOSEN_ROLES.has(facts.role) && secretField(facts)))
        return;
      this.log.clicked(facts, (await bounded(probe.title())) ?? '');
      return;
    }
    if (event.k === 'key' && event.down && (event.key === 'Tab' || event.key === 'Escape')) {
      this.typing = false;
      this.log.left();
      return;
    }
    if (event.k === 'key' && event.down && event.key === 'Enter') {
      this.typing = false;
      this.log.pressed('Enter');
      return;
    }
    const types = event.k === 'text' || (event.k === 'key' && event.down && Boolean(event.text));
    if (!types) return;
    this.log.typing();
    if (this.typing) return;
    this.typing = true;
    const facts = await bounded(probe.focused());
    if (facts && typedInto(facts)) this.log.filled(facts);
  }

  navigated(url: string, title: string): void {
    this.typing = false;
    this.log.opened(url, title);
  }

  downloaded(file: string, type: string): void {
    this.log.downloaded(file, type);
  }
}

/**
 * The probe through the live channel's own DevTools session. The element is found in a world of
 * its own, which the page's scripts cannot reach, and its role and name are Chromium's
 * accessibility tree's, never the page's say. Needs a real Chromium.
 */
export function cdpTeachProbe(cdp: CDPSession, page: Pick<Page, 'title'>): TeachProbe {
  const world = async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'melete-teach',
    });
    return executionContextId;
  };
  const attributesOf = async (backendNodeId: number) => {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
    const attributes: Record<string, string> = {};
    const flat = node.attributes ?? [];
    for (let index = 0; index + 1 < flat.length; index += 2)
      attributes[String(flat[index]).toLowerCase()] = String(flat[index + 1]);
    return { tag: node.nodeName.toLowerCase(), attributes };
  };
  const factsOf = async (backendNodeId: number): Promise<ElementFacts | undefined> => {
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: true,
    });
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    let current = nodes.find((node) => node.backendDOMNodeId === backendNodeId) ?? nodes[0];
    // The nearest of the element and its ancestors that a press means something on.
    for (let depth = 0; current && depth < 16; depth++) {
      const role = String(current.role?.value ?? '');
      if (PRESSED_ROLES.has(role) && current.backendDOMNodeId !== undefined) {
        const own = await attributesOf(current.backendDOMNodeId);
        return {
          role,
          name: String(current.name?.value ?? ''),
          ...own,
          node: current.backendDOMNodeId,
        };
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return undefined;
  };
  const elementOf = async (expression: string) => {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression,
      contextId: await world(),
      returnByValue: false,
    });
    if (!result.objectId) return undefined;
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    return factsOf(node.backendNodeId);
  };
  return {
    at: (x, y) => elementOf(`document.elementFromPoint(${Number(x)}, ${Number(y)})`),
    focused: () => elementOf('document.activeElement'),
    title: () => page.title(),
  };
}
