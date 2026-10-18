/**
 * Which actions move money.
 *
 * Moving money or making a transaction (a payment, a purchase, a transfer, a
 * refund, a booking that charges) is the one class of action the agent never
 * does on its own: each one needs the person's own confirmation, given at
 * that moment with their password or passkey (`step-up.ts`). The broker
 * enforces it; no prompt, setting or standing rule turns it off.
 *
 * A tool's declared effect is where the answer starts, never where it ends.
 * A connected app's server describes its own tools, and the person, adding a
 * server by its address, chooses how far each may act, so a tool that moves
 * money can arrive declared as a read. The answer here is the declared effect
 * joined with a maintained map of names and argument shapes, and anything the
 * map cannot rule out fails closed:
 *
 * - a tool declared `spend` moves money, unless it is one of Melete's own
 *   metered capabilities (speech, transcription), whose cost is the
 *   installation's usage under its budgets, not a transaction;
 * - a tool whose name says it pays, charges, refunds, buys or checks out moves
 *   money, unless its name only looks something up (`list_payments`); a
 *   lookup that also acts (`check_and_pay`, `validateThenCharge`) does not
 *   only look;
 * - a tool whose name says it orders, books, reserves or transfers moves money
 *   when its arguments carry an amount with a currency or a way to pay, or
 *   when it belongs to a payment provider (`paypal.capture_order`);
 * - a tool whose arguments carry a way to pay (a card, a payment method, a bank
 *   account) moves money whatever it is called, and so does a call whose own
 *   arguments carry one under a schema that did not name it; a card's number
 *   or code, a payment token or a bank's routing details decide it even on a
 *   tool declared as a read;
 * - a connected server's own name for a tool is judged as well as the alias
 *   Melete shows, and a tool that runs another named action (`{ tool,
 *   arguments }`) is judged by the action it runs; one whose action it cannot
 *   name fails closed unless it is declared a read;
 * - a form the agent submits from its browser moves money when its fields or
 *   its button pay (`submitPays`), whatever else it carries.
 *
 * One exception is declared by the installation, never by the app's server:
 * a tool whose result is a page (`ui://`) where the person pays for
 * themselves, such as a checkout they complete with their own hands. Opening
 * that page moves no money, so it needs no step-up, as long as the call
 * carries no way to pay and the tool is not declared `spend`.
 *
 * Melete's own workspace tools (commands, files, the agent's own computer) are
 * not judged by this map: an `amount` there is a count, such as a scroll's
 * wheel steps, and nothing there reaches a payment provider through Melete.
 */
import {
  CAPABILITY_KINDS,
  type ConnectorTool,
  type JsonObject,
  type JsonValue,
} from '@melete/contracts';
import { submitPays } from './auto-review.ts';

/** Providers whose tools work only inside the agent's own workspace. */
const OWN_WORKSPACE_PROVIDERS = new Set(['exec', 'sandbox', 'files']);
/** The agent's own computer and the person's paired one: driven step by step, never a payment API. */
const OWN_COMPUTER = /^(?:computer|device|terminal)\./;

/** A name that only looks: `get_invoice`, `list-payments`, `searchCharges`. */
const LOOKS =
  /^(?:get|list|search|find|fetch|read|query|lookup|describe|show|view|count|retrieve|preview|estimate|quote|check|validate)(?:$|[_.-]|[A-Z])/;
/**
 * Words that, after a lookup's verb, make the name do something as well:
 * `check_and_pay`, `validateThenCharge`, `quote_and_book`, `get_or_create_payment`.
 * Only words that are never the thing looked up; `get_charge` still only looks.
 */
const ALSO_ACTS = new Set([
  'and',
  'then',
  'plus',
  'or',
  'pay',
  'buy',
  'purchase',
  'checkout',
  'send',
  'submit',
  'create',
  'make',
  'place',
  'execute',
  'process',
  'complete',
  'confirm',
  'remit',
  'donate',
  'withdraw',
  'subscribe',
  'renew',
  'upgrade',
]);
/**
 * Payment processors: an app of theirs that orders, captures or transfers
 * moves money whether or not its arguments name a price.
 */
const PAYMENT_PROVIDERS = new Set([
  'stripe',
  'paypal',
  'square',
  'squareup',
  'braintree',
  'adyen',
  'wise',
  'venmo',
  'coinbase',
  'plaid',
  'razorpay',
  'mollie',
  'klarna',
  'revolut',
  'payoneer',
  'gocardless',
  'paddle',
  'lemonsqueezy',
]);

/** Words that, in a tool's name, mean money moves or is committed. */
const MOVES = new Set([
  'pay',
  'pays',
  'payment',
  'payments',
  'payout',
  'payouts',
  'charge',
  'charges',
  'refund',
  'refunds',
  'purchase',
  'purchases',
  'buy',
  'checkout',
  'deposit',
  'donate',
  'donation',
  'remit',
  'remittance',
  'wire',
  'invoice',
  'invoices',
]);
/** Words in MOVES that are as often a document as an act: a tool declared a read that names one only looks it up. */
const DOCUMENTS = new Set(['invoice', 'invoices']);
/** Words beside `checkout` that make it a branch, not a purchase. */
const SOURCE_CONTROL = new Set([
  'git',
  'branch',
  'repo',
  'repository',
  'commit',
  'ref',
  'worktree',
]);
/** Words that move money when the arguments carry an amount or a way to pay. */
const MAY_MOVE = new Set([
  'order',
  'orders',
  'book',
  'booking',
  'bookings',
  'reserve',
  'reservation',
  'reservations',
  'transfer',
  'transfers',
  'send',
  'ticket',
  'tickets',
  'renew',
  'upgrade',
  'cart',
  'capture',
  'tip',
  // A channel, a calendar or change notifications are subscribed to as often as a plan.
  'subscribe',
  'subscription',
  'subscriptions',
  // An invitation or an application is withdrawn as often as cash.
  'withdraw',
  'withdrawal',
]);

/** Argument names that are a way to pay: any one of them is enough. */
const PAYING_FIELD =
  /^(?:card_?number|card_?token|card_?details|credit_?card|debit_?card|cc_?number|cc_?num|cvv|cvc|csc|payment|payment_?method|payment_?method_?id|payment_?methods|payment_?source|payment_?token|payment_?details|funding_?source|iban|bic|swift|routing_?number|account_?number|bank_?account|beneficiary|payee|wallet|wallet_?address)$/i;
/**
 * The part of a way to pay that only paying asks for: a card's own number or
 * code, a bank's routing details. No lookup takes these, so a tool that does
 * moves money whatever it is called or declared to be.
 */
const CHARGEABLE_FIELD =
  /^(?:card_?number|card_?details|credit_?card|debit_?card|cc_?number|cc_?num|cvv|cvc|csc|card_?token|payment_?token|payment_?details|iban|routing_?number|wallet_?address|funding_?source)$/i;
/** Argument names that are an amount of money. */
const AMOUNT_FIELD =
  /^(?:amount|amounts|amount_?cents|amount_?usd|unit_?amount|total|total_?amount|price|unit_?price|cost|fare|value_?usd|subtotal|grand_?total|tip_?amount)$/i;
/** Argument names that name a currency. */
const CURRENCY_FIELD = /^(?:currency|currency_?code|iso_?currency)$/i;

/** A name's words, lower case: `createPaymentIntent` and `create-payment_intent` both read `create payment intent`. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A name's words with `check out` read as one: `checkOut` and `check_out` are
 * a checkout, not a lookup that starts with `check`.
 */
function verbWords(name: string): string[] {
  const words = nameWords(name);
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++)
    if (words[i] === 'check' && words[i + 1] === 'out') {
      joined.push('checkout');
      i++;
    } else joined.push(words[i] as string);
  return joined;
}

/** Whether a name only looks something up: a lookup's verb, and nothing done besides. */
function onlyLooks(name: string): boolean {
  if (!LOOKS.test(name)) return false;
  const words = verbWords(name);
  return words[0] !== 'checkout' && !words.slice(1).some((word) => ALSO_ACTS.has(word));
}

/**
 * The tool a generic runner carries out, when the call names it: a connected
 * catalog whose one `act` tool takes `{tool, arguments}` runs whatever action
 * `tool` names, so that action, not the runner, is what is judged.
 */
function carriedTool(
  schema: JsonValue,
  payload: JsonObject | undefined,
): { name: string | null } | null {
  const properties =
    schema && typeof schema === 'object' && !Array.isArray(schema) ? schema.properties : null;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const nameKey = ['tool', 'tool_slug', 'tool_name'].find((key) => key in properties);
  const argsKey = ['arguments', 'args', 'params', 'parameters', 'input'].find(
    (key) => key in properties,
  );
  if (!nameKey || !argsKey) return null;
  const named = payload?.[nameKey];
  return { name: typeof named === 'string' && named.trim() ? named.trim() : null };
}

type Shape = { paying: boolean; chargeable: boolean; amount: boolean; currency: boolean };

/** Every property name a JSON Schema declares, at any depth. */
function schemaNames(schema: JsonValue, found: string[] = [], depth = 0): string[] {
  if (depth > 12 || schema === null || typeof schema !== 'object') return found;
  if (Array.isArray(schema)) {
    for (const item of schema) schemaNames(item, found, depth + 1);
    return found;
  }
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties))
    for (const [key, value] of Object.entries(properties)) {
      found.push(key);
      schemaNames(value as JsonValue, found, depth + 1);
    }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf'])
    if (key in schema) schemaNames(schema[key] as JsonValue, found, depth + 1);
  for (const key of ['$defs', 'definitions']) {
    const defined = schema[key];
    if (defined && typeof defined === 'object' && !Array.isArray(defined))
      for (const value of Object.values(defined)) schemaNames(value as JsonValue, found, depth + 1);
  }
  return found;
}

/** Every key a payload carries, at any depth. */
function payloadNames(value: JsonValue, found: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) for (const item of value) payloadNames(item, found, depth + 1);
  else
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      payloadNames(nested as JsonValue, found, depth + 1);
    }
  return found;
}

function shapeOf(names: readonly string[]): Shape {
  const plain = names.map((name) => nameWords(name).join('_'));
  return {
    paying: plain.some((name) => PAYING_FIELD.test(name)),
    chargeable: plain.some((name) => CHARGEABLE_FIELD.test(name)),
    amount: plain.some((name) => AMOUNT_FIELD.test(name)),
    currency: plain.some((name) => CURRENCY_FIELD.test(name)),
  };
}

const NO_SHAPE: Shape = { paying: false, chargeable: false, amount: false, currency: false };

const merge = (a: Shape, b: Shape): Shape => ({
  paying: a.paying || b.paying,
  chargeable: a.chargeable || b.chargeable,
  amount: a.amount || b.amount,
  currency: a.currency || b.currency,
});

/**
 * A page a connected app opens in the conversation, where the person pays in
 * the page themselves (MCP Apps, a `ui://` page). It is declared by the
 * installation's own policy for that tool, never by the app's server, and the
 * work settles only on the outcome the server signs.
 */
export type PersonPaysPage = { uri: string; personPays: boolean };

export type MoneyMove = {
  /** Why it counts, in the person's words. */
  reason: string;
  /** Which part of the classification decided it. */
  by: 'declared' | 'name' | 'arguments' | 'form';
};

const MOVES_MONEY = 'It moves money.';

/**
 * Whether an action moves money, or null. `tool` is the tool as its connector
 * declares it; `payload` the call's own arguments, when there is one yet.
 * `metered` is true for Melete's own metered capabilities. Pure, so the
 * broker can ask it at every phase and a test can pin every boundary.
 */
export function moneyMove(input: {
  tool: Pick<ConnectorTool, 'name' | 'effect_class' | 'input_schema'> & { execution?: string };
  provider: string;
  payload?: JsonObject;
  /** The tool's name on its own server, when a connector renamed it. */
  rawName?: string;
  metered?: boolean;
  /** The page this tool opens, as the installation's policy declares it (`PersonPaysPage`). */
  page?: PersonPaysPage | null;
}): MoneyMove | null {
  const { tool, provider, payload } = input;
  if (tool.name === 'browser.submit')
    return payload && submitPays(payload) ? { reason: 'Its form pays or buys.', by: 'form' } : null;
  if (input.metered && (CAPABILITY_KINDS as readonly string[]).includes(tool.name)) return null;
  if (tool.effect_class === 'spend') return { reason: MOVES_MONEY, by: 'declared' };
  if (
    OWN_WORKSPACE_PROVIDERS.has(provider) ||
    OWN_COMPUTER.test(tool.name) ||
    tool.execution === 'in_cell'
  )
    return null;
  const shape = merge(
    shapeOf(schemaNames(tool.input_schema as JsonValue)),
    payload ? shapeOf(payloadNames(payload)) : NO_SHAPE,
  );
  // Opening a page where the person pays for themselves moves nothing: their
  // own entry in the page is the confirmation, and the work settles only on
  // the outcome the app's server signs. A call that itself carries a way to
  // pay is not that, whatever the page.
  if (
    input.page?.personPays === true &&
    input.page.uri.startsWith('ui://') &&
    !(payload && shapeOf(payloadNames(payload)).paying)
  )
    return null;
  // A connector's own name for the tool is `connector.verb`; the verb is what
  // it does. A server's tools keep their own names too, and both are read. A
  // runner that carries out another named action is judged by that action.
  const connectorName = tool.name.includes('.') ? tool.name.slice(0, tool.name.indexOf('.')) : '';
  const carried = carriedTool(tool.input_schema as JsonValue, payload);
  const verbs = [tool.name.slice(tool.name.indexOf('.') + 1), input.rawName ?? ''].filter(Boolean);
  if (carried) {
    // A runner whose action cannot be read cannot be shown not to move money.
    if (carried.name === null)
      return tool.effect_class === 'read'
        ? null
        : { reason: 'It runs an action Melete cannot name.', by: 'name' };
    // `STRIPE_LIST_CHARGES` on the Stripe app is `list_charges`.
    const app = new Set(nameWords(connectorName));
    const own = nameWords(carried.name);
    while (own.length > 1 && app.has(own[0] as string)) own.shift();
    verbs.splice(0, verbs.length, own.join('_'));
  }
  const looks = verbs.some(onlyLooks);
  const words = new Set([...verbs.flatMap(verbWords)]);
  const processor = [...nameWords(connectorName), ...(carried?.name ? nameWords(carried.name) : [])]
    .concat(input.rawName ? nameWords(input.rawName) : [])
    .some((word) => PAYMENT_PROVIDERS.has(word));
  const priced = shape.paying || (shape.amount && shape.currency);
  const branch = [...words].some((word) => SOURCE_CONTROL.has(word));
  const read = tool.effect_class === 'read';
  if (
    !looks &&
    [...words].some(
      (word) =>
        MOVES.has(word) && !(word === 'checkout' && branch) && !(read && DOCUMENTS.has(word)),
    )
  )
    return { reason: MOVES_MONEY, by: 'name' };
  if (!looks && (priced || processor) && [...words].some((word) => MAY_MOVE.has(word)))
    return { reason: 'It orders, books or transfers something that is paid for.', by: 'name' };
  // A card's own number or code, or a bank's routing details, are asked for
  // only to pay, so they decide it whatever the tool is called or declared.
  if (shape.chargeable)
    return { reason: 'It takes a card, account or other way to pay.', by: 'arguments' };
  // A way to pay among the arguments decides it, whatever the tool is called
  // or declared to be: an unknown tool that takes a card is a payment.
  // A lookup declared as a read may filter by one (`list_charges` by card).
  if (shape.paying && !(looks && read))
    return { reason: 'It takes a card, account or other way to pay.', by: 'arguments' };
  if (!looks && shape.amount && shape.currency && !read)
    return { reason: 'It takes an amount of money.', by: 'arguments' };
  return null;
}
