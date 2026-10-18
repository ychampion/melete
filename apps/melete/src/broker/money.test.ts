import { describe, expect, test } from 'bun:test';
import { type ConnectorManifest, type JsonObject, MCP_CATALOG } from '@melete/contracts';
import { appsManifest } from '../connectors/apps.ts';
import { artifactsManifest } from '../connectors/artifacts.ts';
import { browserManifest } from '../connectors/browser.ts';
import { calendarManifest } from '../connectors/calendar.ts';
import { emailManifest, idAddressedEmailManifest } from '../connectors/email.ts';
import { execManifest } from '../connectors/exec.ts';
import { filesManifest } from '../connectors/files.ts';
import { googleCalendarManifest } from '../connectors/google-calendar.ts';
import { driveManifest } from '../connectors/google-drive.ts';
import { notesManifest } from '../connectors/notes.ts';
import { outlookCalendarManifest } from '../connectors/outlook-calendar.ts';
import { roomManifest } from '../connectors/room.ts';
import { sandboxExecManifest, sandboxTerminalManifest } from '../connectors/sandbox-exec.ts';
import { skillsManifest } from '../connectors/skills.ts';
import { smsManifest } from '../connectors/sms.ts';
import { webManifest } from '../connectors/web.ts';
import { deviceManifest } from '../devices/connector.ts';
import { moneyMove } from './money.ts';

const BUILTIN: ConnectorManifest[] = [
  appsManifest,
  artifactsManifest,
  browserManifest,
  calendarManifest,
  emailManifest,
  idAddressedEmailManifest,
  execManifest,
  filesManifest,
  googleCalendarManifest,
  driveManifest,
  notesManifest,
  outlookCalendarManifest,
  roomManifest,
  sandboxExecManifest,
  sandboxTerminalManifest,
  skillsManifest,
  smsManifest,
  webManifest,
  deviceManifest('Laptop'),
];

const schema = (...names: string[]): JsonObject => ({
  type: 'object',
  properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
});
/** A connected app's tool, as its server names and describes it. */
const app = (
  name: string,
  input_schema: JsonObject = { type: 'object' },
  effect_class: 'read' | 'write_reversible' | 'write_external' | 'spend' = 'write_external',
  payload?: JsonObject,
) =>
  moneyMove({
    tool: { name: `mcp_app.${name}`, effect_class, input_schema },
    provider: 'mcp',
    rawName: name,
    ...(payload ? { payload } : {}),
  });

describe('which tools move money', () => {
  test('no tool Melete ships moves money by its declaration alone', () => {
    const flagged = BUILTIN.flatMap((manifest) =>
      manifest.tools
        .filter((tool) => moneyMove({ tool, provider: manifest.provider }))
        .map((tool) => tool.name),
    );
    expect(flagged).toEqual([]);
  });

  test('in the catalog, exactly the tools declared as spending move money', () => {
    for (const entry of MCP_CATALOG)
      for (const tool of entry.tools) {
        const found = moneyMove({
          tool: {
            name: `mcp_${entry.id}.${tool.alias}`,
            effect_class: tool.effect_class,
            input_schema: { type: 'object' },
          },
          provider: 'mcp',
          rawName: tool.name,
        });
        expect([entry.id, tool.name, found !== null]).toEqual([
          entry.id,
          tool.name,
          tool.effect_class === 'spend',
        ]);
      }
  });

  test("Melete's own metered speech and transcription are usage, not transactions", () => {
    const tool = { name: 'audio.synthesize', effect_class: 'spend' as const, input_schema: {} };
    expect(moneyMove({ tool, provider: 'generation', metered: true })).toBeNull();
    // The same name from somewhere else that declares it spends is held.
    expect(moneyMove({ tool, provider: 'mcp' })).not.toBeNull();
  });

  test.each([
    ['pay_bill', schema('biller')],
    ['createRefund', schema('charge')],
    ['buy-ticket', schema('event')],
    ['checkout', schema('cart_id')],
    ['send_invoice', schema('customer')],
    ['book_flight', schema('offer_id', 'total_amount', 'currency')],
    ['transfer', schema('iban', 'note')],
    ['go', { type: 'object', properties: { details: schema('card_number') } }],
    ['subscribe', schema('plan', 'payment_method')],
  ])('%s moves money', (name, input) => {
    expect(app(name, input)).not.toBeNull();
  });

  test.each([
    ['list_payments', schema('customer')],
    ['getInvoice', schema('invoice_id')],

    ['git_checkout', schema('branch')],
    ['checkout_branch', schema('repo', 'branch')],
    ['subscribe_to_channel', schema('channel')],
    ['create_subscription', schema('resource', 'notification_url')],
    ['withdraw_invitation', schema('invitation_id')],
    ['book_meeting_room', schema('room', 'start')],
    ['transfer_issue', schema('issue', 'team')],
    ['update_card', schema('card', 'card_id', 'list_id')],
    ['duplicate_page', schema('source_id', 'title')],
    ['send_message', schema('channel', 'text')],
    ['create_issue', schema('title', 'body')],
  ])('%s does not', (name, input) => {
    expect(app(name, input)).toBeNull();
  });

  test('an invoice is a document as often as an act: a read named for one looks it up', () => {
    expect(app('invoice', schema('vendor'), 'read')).toBeNull();
    expect(app('invoice', schema('vendor'))).not.toBeNull();
    expect(app('pay', schema('vendor'), 'read')).not.toBeNull();
  });

  test('a lookup that filters by a way to pay is a read; the same as a change is not', () => {
    const filter = schema('payment_method', 'limit');
    expect(app('list_charges', filter, 'read')).toBeNull();
    expect(app('list_charges', filter, 'write_external')).not.toBeNull();
  });

  test('a call that carries a way to pay is held though its schema named none', () => {
    expect(app('do_it', { type: 'object' }, 'write_reversible')).toBeNull();
    expect(
      app('do_it', { type: 'object' }, 'write_reversible', { payee: 'City Water', amount: 4 }),
    ).not.toBeNull();
  });

  test("the agent's own computer and workspace are not judged by app names", () => {
    const scroll = { name: 'computer.scroll', effect_class: 'write_reversible' as const };
    expect(
      moneyMove({
        tool: { ...scroll, input_schema: schema('amount', 'currency') },
        provider: 'sandbox',
      }),
    ).toBeNull();
    expect(
      moneyMove({
        tool: {
          name: 'exec.run',
          effect_class: 'write_reversible',
          input_schema: schema('card_number'),
        },
        provider: 'exec',
      }),
    ).toBeNull();
  });

  test('a lookup verb does not hide a second act, and checking out is not checking', () => {
    const priced = schema('amount', 'currency', 'invoice_id');
    for (const name of ['check_and_pay', 'validateThenCharge', 'get_or_create_payment'])
      expect([name, app(name, priced) !== null]).toEqual([name, true]);
    for (const name of ['checkOut', 'check_out', 'check-out'])
      expect([name, app(name, schema('cart_id')) !== null]).toEqual([name, true]);
    // A plain lookup still only looks.
    expect(app('get_charge', schema('charge_id'), 'read')).toBeNull();
    expect(app('check_payment_status', schema('payment_id'), 'read')).toBeNull();
  });

  test("a card's own number or code is asked for only to pay, whatever the tool says it is", () => {
    expect(app('get_status', schema('card_number', 'cvv'), 'read')).not.toBeNull();
    expect(app('lookup', schema('iban'), 'read')).not.toBeNull();
    // A lookup that filters by a saved way to pay still only looks.
    expect(app('list_charges', schema('payment_method'), 'read')).toBeNull();
  });

  test("a server's own name for a renamed tool is read with the alias", () => {
    const go = { name: 'mcp_bank.go', effect_class: 'write_external' as const, input_schema: {} };
    expect(moneyMove({ tool: go, provider: 'mcp' })).toBeNull();
    expect(moneyMove({ tool: go, provider: 'mcp', rawName: 'pay_invoice' })).not.toBeNull();
  });

  test('a runner of named actions is judged by the action it runs', () => {
    const act = {
      name: 'app_stripe.act',
      effect_class: 'write_external' as const,
      input_schema: schema('tool', 'arguments'),
    };
    const run = (tool: string, args: JsonObject = {}) =>
      moneyMove({ tool: act, provider: 'composio', payload: { tool, arguments: args } });
    for (const slug of [
      'STRIPE_CREATE_REFUND',
      'STRIPE_CONFIRM_PAYMENT_INTENT',
      'STRIPE_CAPTURE_PAYMENT_INTENT',
      'QUICKBOOKS_CREATE_PAYMENT',
      'QUICKBOOKS_CREATE_INVOICE',
    ])
      expect([slug, run(slug) !== null]).toEqual([slug, true]);
    expect(run('STRIPE_LIST_CHARGES')).toBeNull();
    expect(run('STRIPE_CREATE_CUSTOMER', { email: 'a@b.c' })).toBeNull();
    // Without the action's name nothing shows it does not pay.
    expect(moneyMove({ tool: act, provider: 'composio', payload: {} })).not.toBeNull();
  });

  test("a payment processor's order or capture moves money without a price", () => {
    expect(
      moneyMove({
        tool: {
          name: 'mcp_paypal.capture_order',
          effect_class: 'write_external',
          input_schema: schema('order_id'),
        },
        provider: 'mcp',
      }),
    ).not.toBeNull();
    // Elsewhere an order still needs a price or a way to pay to count.
    expect(app('create_order', schema('items'))).toBeNull();
  });

  test('a page where the person pays for themselves needs no step-up to open', () => {
    const checkout = {
      name: 'mcp_shop.checkout',
      effect_class: 'write_external' as const,
      input_schema: schema('cart_id'),
    };
    const page = { uri: 'ui://shop/checkout', personPays: true };
    expect(moneyMove({ tool: checkout, provider: 'mcp', page })).toBeNull();
    // Without that declaration a checkout fails closed, as does a page that
    // does not say the person pays, one that is not an MCP Apps page, a call
    // that itself carries a card, and a tool declared to spend.
    expect(moneyMove({ tool: checkout, provider: 'mcp' })).not.toBeNull();
    expect(
      moneyMove({ tool: checkout, provider: 'mcp', page: { ...page, personPays: false } }),
    ).not.toBeNull();
    expect(
      moneyMove({ tool: checkout, provider: 'mcp', page: { ...page, uri: 'https://shop/pay' } }),
    ).not.toBeNull();
    expect(
      moneyMove({ tool: checkout, provider: 'mcp', page, payload: { card_number: '4242' } }),
    ).not.toBeNull();
    expect(
      moneyMove({ tool: { ...checkout, effect_class: 'spend' }, provider: 'mcp', page }),
    ).not.toBeNull();
  });

  test('a form the agent submits moves money when it pays', () => {
    const submit = {
      name: 'browser.submit',
      effect_class: 'write_external' as const,
      input_schema: {},
    };
    const intent = (fields: JsonObject, name = 'Continue') => ({ intent: { fields, name } });
    expect(
      moneyMove({ tool: submit, provider: 'browser', payload: intent({ card_number: '4242' }) }),
    ).not.toBeNull();
    expect(
      moneyMove({
        tool: submit,
        provider: 'browser',
        payload: intent({ email: 'a@b.c' }, 'Pay now'),
      }),
    ).not.toBeNull();
    expect(
      moneyMove({ tool: submit, provider: 'browser', payload: intent({ q: 'flights' }, 'Search') }),
    ).toBeNull();
    // Card fields as shops name them, a card number in any field, and the buttons that buy.
    const cardFields: Record<string, string>[] = [
      { cardnumber: '1' },
      { ccnum: '1' },
      { cvv: '123' },
      { exp_month: '12' },
    ];
    for (const fields of cardFields)
      expect(
        moneyMove({ tool: submit, provider: 'browser', payload: intent(fields) }),
      ).not.toBeNull();
    expect(
      moneyMove({
        tool: submit,
        provider: 'browser',
        payload: intent({ n: '4242 4242 4242 4242' }),
      }),
    ).not.toBeNull();
    for (const button of ['Place your order', 'Submit order', 'Book now', 'Confirm and pay'])
      expect(
        moneyMove({ tool: submit, provider: 'browser', payload: intent({ qty: '1' }, button) }),
      ).not.toBeNull();
    // A number that is not a card, and a newsletter's own button, do not pay.
    for (const [fields, button] of [
      [{ phone: '4155550123' }, 'Continue'],
      [{ email: 'a@b.c' }, 'Subscribe'],
    ] as const)
      expect(
        moneyMove({ tool: submit, provider: 'browser', payload: intent(fields, button) }),
      ).toBeNull();
  });
});
