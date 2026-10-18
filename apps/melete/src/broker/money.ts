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
 *   money, unless its name only looks something up (`list_payments`);
 * - a tool whose name says it orders, books, reserves or transfers moves money
 *   when its arguments carry an amount with a currency or a way to pay;
 * - a tool whose arguments carry a way to pay (a card, a payment method, a bank
 *   account) moves money whatever it is called, and so does a call whose own
 *   arguments carry one under a schema that did not name it;
 * - a form the agent submits from its browser moves money when its fields or
 *   its button pay (`submitPays`), whatever else it carries.
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
  /^(?:card_?number|card_?token|card_?details|credit_?card|debit_?card|cc_?number|cvv|cvc|payment|payment_?method|payment_?method_?id|payment_?methods|payment_?source|payment_?token|payment_?details|funding_?source|iban|bic|swift|routing_?number|account_?number|bank_?account|beneficiary|payee|wallet|wallet_?address)$/i;
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

type Shape = { paying: boolean; amount: boolean; currency: boolean };

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
    amount: plain.some((name) => AMOUNT_FIELD.test(name)),
    currency: plain.some((name) => CURRENCY_FIELD.test(name)),
  };
}

const merge = (a: Shape, b: Shape): Shape => ({
  paying: a.paying || b.paying,
  amount: a.amount || b.amount,
  currency: a.currency || b.currency,
});

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
  // A connector's own name for the tool is `connector.verb`; the verb is what
  // it does. A server's tools keep their own names too, and both are read.
  const verbs = [tool.name.slice(tool.name.indexOf('.') + 1), input.rawName ?? ''].filter(Boolean);
  const looks = verbs.some((verb) => LOOKS.test(verb));
  const words = new Set(verbs.flatMap(nameWords));
  const shape = merge(
    shapeOf(schemaNames(tool.input_schema as JsonValue)),
    payload ? shapeOf(payloadNames(payload)) : { paying: false, amount: false, currency: false },
  );
  const priced = shape.paying || (shape.amount && shape.currency);
  const branch = [...words].some((word) => SOURCE_CONTROL.has(word));
  if (!looks && [...words].some((word) => MOVES.has(word) && !(word === 'checkout' && branch)))
    return { reason: MOVES_MONEY, by: 'name' };
  if (!looks && priced && [...words].some((word) => MAY_MOVE.has(word)))
    return { reason: 'It orders, books or transfers something that is paid for.', by: 'name' };
  // A way to pay among the arguments decides it, whatever the tool is called
  // or declared to be: an unknown tool that takes a card is a payment.
  // A lookup declared as a read may filter by one (`list_charges` by card).
  if (shape.paying && !(looks && tool.effect_class === 'read'))
    return { reason: 'It takes a card, account or other way to pay.', by: 'arguments' };
  if (!looks && shape.amount && shape.currency && tool.effect_class !== 'read')
    return { reason: 'It takes an amount of money.', by: 'arguments' };
  return null;
}
