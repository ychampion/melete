/**
 * The invented mailbox the companies screen is built against: nine companies a
 * freelancer deals with, the messages they sent, and the ledger read out of
 * them. Every name, address and figure here is made up.
 *
 * The evidence rule from the contract holds in the fixture too. A row names the
 * sentence it came from as a plain quote; the spans are derived from the stored
 * message text rather than typed by hand, and a quote that is not in its message
 * stops the mock at start-up instead of reaching a screen.
 */
import { newId } from './store.ts';

export type FixtureMessage = {
  id: string;
  subject: string;
  from: string;
  received_at: string;
  text: string;
};

export type FixtureEvidence = { message_id: string; quote: string; start: number; end: number };

export type FixtureCompany = {
  id: string;
  space_id: string;
  name: string;
  domain: string;
  monthly_spend_minor: number | null;
  currency: string | null;
  first_seen_at: string;
  last_seen_at: string;
  message_count: number;
};

export type FixtureItem = {
  id: string;
  space_id: string;
  principal_id: string;
  company_id: string;
  kind: string;
  direction: string;
  amount_minor: number | null;
  currency: string | null;
  due_at: string | null;
  status: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: FixtureEvidence[];
  suggested_playbook: string | null;
  job_id: string | null;
  summary: string;
};

export type Fixture = {
  companies: FixtureCompany[];
  items: FixtureItem[];
  messages: Map<string, FixtureMessage>;
  currency: string;
  /** The address the person's own mail goes out from, shown on the approval. */
  from_address: string;
};

const DAY = 86_400_000;

/** A whole-day timestamp `days` from now, so the fixture reads the same tomorrow. */
const at = (days: number, hour = 9, minute = 12): string => {
  const date = new Date(Date.now() + days * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};

type Draft = {
  company: {
    name: string;
    domain: string;
    monthly_spend_minor?: number;
    first_seen_days: number;
    last_seen_days: number;
    message_count: number;
  };
  messages: { key: string; subject: string; from: string; received_days: number; text: string }[];
  items: {
    message: string;
    kind: string;
    direction: string;
    amount_minor?: number;
    due_days?: number;
    status?: string;
    confidence?: 'high' | 'medium' | 'low';
    playbook?: string;
    summary: string;
    quotes: string[];
  }[];
};

/**
 * The mailbox, written the way it would arrive. `quotes` are lifted from the
 * message text below them; `build` finds each one and records its span.
 */
const DRAFTS: Draft[] = [
  {
    company: {
      name: 'Kestrel Analytics',
      domain: 'kestrel-analytics.example',
      monthly_spend_minor: 9600,
      first_seen_days: -412,
      last_seen_days: -6,
      message_count: 31,
    },
    messages: [
      {
        key: 'kestrel-rise',
        subject: 'A change to your Kestrel plan',
        from: 'Kestrel Analytics <billing@kestrel-analytics.example>',
        received_days: -6,
        text: [
          'Hello Jamie,',
          '',
          'We are writing to let you know that the price of your Team plan is changing.',
          'From 1 November your plan will cost £128.00 a month instead of £96.00. The new price applies from your next renewal.',
          '',
          'Your plan includes 8 seats. Our records show 3 of them have been used in the last 90 days.',
          '',
          'If you would like to change plan or reduce your seat count you can do that at any time before the renewal date and we will apply the lower price straight away.',
          '',
          'Thank you for being with us.',
          'The Kestrel team',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'kestrel-rise',
        kind: 'price_rise',
        direction: 'you_pay',
        amount_minor: 3200,
        due_days: 44,
        confidence: 'high',
        playbook: 'price-rise',
        summary: 'Kestrel is putting your Team plan up by £32 a month from 1 November',
        quotes: ['From 1 November your plan will cost £128.00 a month instead of £96.00.'],
      },
      {
        message: 'kestrel-rise',
        kind: 'subscription',
        direction: 'you_pay',
        amount_minor: 9600,
        confidence: 'high',
        playbook: 'cancel-subscription',
        summary: 'You pay for 8 seats; 5 went unused for three months',
        quotes: [
          'Your plan includes 8 seats. Our records show 3 of them have been used in the last 90 days.',
        ],
      },
      {
        message: 'kestrel-rise',
        kind: 'promise',
        direction: 'info',
        due_days: 44,
        confidence: 'medium',
        summary: 'They said dropping seats before the renewal cuts the price at once',
        quotes: [
          'If you would like to change plan or reduce your seat count you can do that at any time before the renewal date and we will apply the lower price straight away.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Ashgrove Studio',
      domain: 'ashgrovestudio.example',
      first_seen_days: -260,
      last_seen_days: -21,
      message_count: 48,
    },
    messages: [
      {
        key: 'ashgrove-invoice',
        subject: 'Re: Invoice 0142 — September retainer',
        from: 'Dana Whitlock <dana@ashgrovestudio.example>',
        received_days: -21,
        text: [
          'Hi Jamie,',
          '',
          'Thanks for the work on the reporting screens, the team is very happy with it.',
          '',
          'Invoice 0142 for £2,400.00 is with our finance people now. We pay on 30 day terms from the invoice date, so this one is due on 12 September.',
          '',
          'Sorry it has taken a while to confirm. Anything else outstanding, send it over and we will put it in the same run.',
          '',
          'Dana',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'ashgrove-invoice',
        kind: 'invoice_unpaid',
        direction: 'owed_to_you',
        amount_minor: 240_000,
        due_days: -9,
        confidence: 'high',
        playbook: 'unpaid-invoice',
        summary: 'Invoice 0142 is nine days past its due date',
        quotes: [
          'Invoice 0142 for £2,400.00 is with our finance people now. We pay on 30 day terms from the invoice date, so this one is due on 12 September.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Tern & Co',
      domain: 'ternandco.example',
      first_seen_days: -95,
      last_seen_days: -17,
      message_count: 9,
    },
    messages: [
      {
        key: 'tern-refund',
        subject: 'Your return has been received',
        from: 'Tern & Co <help@ternandco.example>',
        received_days: -17,
        text: [
          'Hello Jamie,',
          '',
          'Good news — your return for order TC-88412 arrived at our warehouse this morning and has passed our checks.',
          '',
          'Your refund of £64.00 will be back with you within 5 working days, to the card you paid with.',
          '',
          'You do not need to do anything else. If the money has not reached you by then, reply to this message and we will chase it for you.',
          '',
          'Tern & Co Customer Care',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'tern-refund',
        kind: 'refund_owed',
        direction: 'owed_to_you',
        amount_minor: 6400,
        due_days: -10,
        confidence: 'high',
        playbook: 'refund-owed',
        summary: 'Refund for the returned order TC-88412',
        quotes: [
          'Your refund of £64.00 will be back with you within 5 working days, to the card you paid with.',
        ],
      },
      {
        message: 'tern-refund',
        kind: 'promise',
        direction: 'info',
        due_days: -10,
        status: 'found',
        confidence: 'high',
        summary: 'They promised the refund within 5 working days',
        quotes: [
          'If the money has not reached you by then, reply to this message and we will chase it for you.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Palewell Mobile',
      domain: 'palewell.example',
      monthly_spend_minor: 1850,
      first_seen_days: -700,
      last_seen_days: -4,
      message_count: 64,
    },
    messages: [
      {
        key: 'palewell-bill',
        subject: 'Your September bill is ready',
        from: 'Palewell Mobile <bills@palewell.example>',
        received_days: -4,
        text: [
          'Your bill for September is ready to view.',
          '',
          'Monthly plan: £18.50',
          'One-off charges: £12.00',
          'Total due on 28 September: £30.50',
          '',
          'The one-off charge of £12.00 is for a Roaming Day Pass used on 2 September.',
          '',
          'If a charge on this bill is not yours, tell us within 60 days of the bill date and we will look into it.',
          '',
          'Palewell Mobile',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'palewell-bill',
        kind: 'wrong_charge',
        direction: 'owed_to_you',
        amount_minor: 1200,
        due_days: 56,
        confidence: 'medium',
        playbook: 'wrong-charge',
        summary: 'A £12 roaming pass for a day you were not abroad',
        quotes: ['The one-off charge of £12.00 is for a Roaming Day Pass used on 2 September.'],
      },
      {
        message: 'palewell-bill',
        kind: 'subscription',
        direction: 'you_pay',
        amount_minor: 1850,
        confidence: 'high',
        summary: 'Your Palewell mobile plan, billed on the 28th',
        quotes: ['Monthly plan: £18.50'],
      },
      {
        message: 'palewell-bill',
        kind: 'promise',
        direction: 'info',
        due_days: 56,
        confidence: 'high',
        summary: '60 days from the bill date to dispute a charge',
        quotes: [
          'If a charge on this bill is not yours, tell us within 60 days of the bill date and we will look into it.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Northwind Broadband',
      domain: 'northwind-broadband.example',
      monthly_spend_minor: 4199,
      first_seen_days: -540,
      last_seen_days: -11,
      message_count: 22,
    },
    messages: [
      {
        key: 'northwind-renewal',
        subject: 'Your contract renews next month',
        from: 'Northwind Broadband <contracts@northwind-broadband.example>',
        received_days: -11,
        text: [
          'Hello Jamie,',
          '',
          'Your 24 month Fibre 150 contract comes to an end soon and will renew automatically.',
          '',
          'Your renewal date is 14 October and your price stays at £41.99 a month, fixed until March 2027.',
          '',
          'If you would rather not renew, let us know at least 14 days before the renewal date and there is nothing to pay to leave.',
          '',
          'Northwind Broadband',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'northwind-renewal',
        kind: 'renewal',
        direction: 'you_pay',
        amount_minor: 4199,
        due_days: 26,
        confidence: 'high',
        summary: 'Fibre 150 renews automatically on 14 October',
        quotes: [
          'Your renewal date is 14 October and your price stays at £41.99 a month, fixed until March 2027.',
        ],
      },
      {
        message: 'northwind-renewal',
        kind: 'promise',
        direction: 'info',
        due_days: 12,
        confidence: 'high',
        summary: 'You can leave free of charge, 14 days before renewal',
        quotes: [
          'If you would rather not renew, let us know at least 14 days before the renewal date and there is nothing to pay to leave.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Larkspur Energy',
      domain: 'larkspurenergy.example',
      monthly_spend_minor: 8800,
      first_seen_days: -830,
      last_seen_days: -9,
      message_count: 40,
    },
    messages: [
      {
        key: 'larkspur-rise',
        subject: 'Your monthly payment is going up',
        from: 'Larkspur Energy <account@larkspurenergy.example>',
        received_days: -9,
        text: [
          'Hello Jamie,',
          '',
          'We have reviewed your account and your monthly direct debit is going up.',
          '',
          'From 1 October your monthly payment will be £104.00, up from £88.00.',
          '',
          'Your account is £61.40 in credit today. If you think the new amount is too high, you can ask us to review it and we will respond within 10 working days.',
          '',
          'Larkspur Energy',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'larkspur-rise',
        kind: 'price_rise',
        direction: 'you_pay',
        amount_minor: 1600,
        due_days: 13,
        confidence: 'high',
        playbook: 'price-rise',
        summary: 'The direct debit goes up £16 while you are in credit',
        quotes: ['From 1 October your monthly payment will be £104.00, up from £88.00.'],
      },
      {
        message: 'larkspur-rise',
        kind: 'promise',
        direction: 'info',
        due_days: 14,
        confidence: 'medium',
        summary: 'They will answer a review within 10 working days',
        quotes: [
          'If you think the new amount is too high, you can ask us to review it and we will respond within 10 working days.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Fernhill Files',
      domain: 'fernhill.example',
      first_seen_days: -34,
      last_seen_days: -2,
      message_count: 6,
    },
    messages: [
      {
        key: 'fernhill-trial',
        subject: 'Your Fernhill trial ends on Friday',
        from: 'Fernhill Files <hello@fernhill.example>',
        received_days: -2,
        text: [
          'Hi Jamie,',
          '',
          'A quick reminder that your 30 day trial of Fernhill Pro ends in 5 days.',
          '',
          'When it ends we will start billing the card on file £19.00 a month unless you cancel first.',
          '',
          'You currently have 41 GB of files with us. If you cancel, we keep your files for 30 days and then delete them.',
          '',
          'Fernhill Files',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'fernhill-trial',
        kind: 'trial_ending',
        direction: 'you_pay',
        amount_minor: 1900,
        due_days: 5,
        confidence: 'high',
        playbook: 'cancel-subscription',
        summary: 'The Pro trial becomes a £19 a month bill in five days',
        quotes: [
          'When it ends we will start billing the card on file £19.00 a month unless you cancel first.',
        ],
      },
      {
        message: 'fernhill-trial',
        kind: 'data_held',
        direction: 'info',
        confidence: 'high',
        summary: 'They hold 41 GB of your files, kept 30 days after leaving',
        quotes: [
          'You currently have 41 GB of files with us. If you cancel, we keep your files for 30 days and then delete them.',
        ],
      },
    ],
  },
  {
    company: {
      name: 'Brightside Insurance',
      domain: 'brightsideinsure.example',
      monthly_spend_minor: 2410,
      first_seen_days: -390,
      last_seen_days: -13,
      message_count: 15,
    },
    messages: [
      {
        key: 'brightside-renewal',
        subject: 'Your renewal quote for 2026/27',
        from: 'Brightside Insurance <renewals@brightsideinsure.example>',
        received_days: -13,
        text: [
          'Dear Jamie,',
          '',
          'Your contents policy BSI-30417 renews on 30 September.',
          '',
          'Your renewal premium is £34.60 a month. Last year you paid £24.10 a month.',
          '',
          'We will renew the policy automatically unless you tell us otherwise. You can cancel within 14 days of renewal and pay only for the days you were covered.',
          '',
          'Brightside Insurance',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'brightside-renewal',
        kind: 'price_rise',
        direction: 'you_pay',
        amount_minor: 1050,
        due_days: 12,
        confidence: 'high',
        playbook: 'price-rise',
        summary: 'Contents cover renews £10.50 a month higher',
        quotes: ['Your renewal premium is £34.60 a month. Last year you paid £24.10 a month.'],
      },
      {
        message: 'brightside-renewal',
        kind: 'renewal',
        direction: 'you_pay',
        amount_minor: 3460,
        due_days: 12,
        confidence: 'high',
        summary: 'Policy BSI-30417 renews automatically on 30 September',
        quotes: ['Your contents policy BSI-30417 renews on 30 September.'],
      },
    ],
  },
  {
    company: {
      name: 'Mossbank Storage',
      domain: 'mossbank.example',
      monthly_spend_minor: 1500,
      first_seen_days: -620,
      last_seen_days: -28,
      message_count: 11,
    },
    messages: [
      {
        key: 'mossbank-receipt',
        subject: 'Receipt for unit 214',
        from: 'Mossbank Storage <accounts@mossbank.example>',
        received_days: -28,
        text: [
          'Thank you for your payment.',
          '',
          'Unit 214, monthly storage: £15.00. Paid by direct debit on 21 August.',
          '',
          'Your unit has not been accessed since 4 March. We hold a copy of your identity documents for as long as your agreement runs.',
          '',
          'To end the agreement we ask for one month of notice in writing.',
          '',
          'Mossbank Storage',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'mossbank-receipt',
        kind: 'subscription',
        direction: 'you_pay',
        amount_minor: 1500,
        confidence: 'high',
        playbook: 'cancel-subscription',
        summary: 'A unit you pay £15 a month for, unopened since March',
        quotes: ['Your unit has not been accessed since 4 March.'],
      },
      {
        message: 'mossbank-receipt',
        kind: 'data_held',
        direction: 'info',
        confidence: 'medium',
        summary: 'They keep your identity documents while the agreement runs',
        quotes: ['We hold a copy of your identity documents for as long as your agreement runs.'],
      },
    ],
  },
  {
    company: {
      name: 'Halliwell & Fox',
      domain: 'halliwellfox.example',
      first_seen_days: -140,
      last_seen_days: -12,
      message_count: 27,
    },
    messages: [
      {
        key: 'halliwell-invoice',
        subject: 'Invoice 0147 received',
        from: 'Priya Nadkarni <priya@halliwellfox.example>',
        received_days: -12,
        text: [
          'Hi Jamie,',
          '',
          'Invoice 0147 for £1,150.00 has gone through to accounts and is scheduled for our 22 September payment run.',
          '',
          'One thing for next time: our terms are 14 days from receipt, so anything you send before the 8th of a month lands in that month.',
          '',
          'Thanks again for turning the brand sheet round so quickly.',
          '',
          'Priya',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'halliwell-invoice',
        kind: 'invoice_unpaid',
        direction: 'owed_to_you',
        amount_minor: 115_000,
        due_days: 4,
        confidence: 'high',
        playbook: 'unpaid-invoice',
        summary: 'Invoice 0147 is in their 22 September payment run',
        quotes: [
          'Invoice 0147 for £1,150.00 has gone through to accounts and is scheduled for our 22 September payment run.',
        ],
      },
      {
        message: 'halliwell-invoice',
        kind: 'promise',
        direction: 'info',
        due_days: 4,
        confidence: 'medium',
        summary: 'They pay 14 days from receipt, on a run on the 22nd',
        quotes: ['our terms are 14 days from receipt'],
      },
    ],
  },
  {
    company: {
      name: 'Corvid Couriers',
      domain: 'corvidcouriers.example',
      first_seen_days: -76,
      last_seen_days: -8,
      message_count: 14,
    },
    messages: [
      {
        key: 'corvid-lost',
        subject: 'About parcel CV-4471902',
        from: 'Corvid Couriers <claims@corvidcouriers.example>',
        received_days: -8,
        text: [
          'Dear Jamie Davis,',
          '',
          'We are sorry to say that we have been unable to locate parcel CV-4471902 and have now marked it as lost in transit.',
          '',
          'You may claim for the value of the contents up to £85.00, which is the cover on the service you paid for. Send us the invoice or receipt for the items and we will assess it.',
          '',
          'Accepted claims are paid within 14 days of acceptance.',
          '',
          'Corvid Couriers Claims',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'corvid-lost',
        kind: 'compensation',
        direction: 'owed_to_you',
        amount_minor: 8500,
        due_days: 6,
        confidence: 'high',
        summary: 'They lost parcel CV-4471902 and owe up to £85 for the contents',
        quotes: [
          'You may claim for the value of the contents up to £85.00, which is the cover on the service you paid for.',
        ],
      },
      {
        message: 'corvid-lost',
        kind: 'promise',
        direction: 'info',
        due_days: 6,
        confidence: 'high',
        summary: 'They pay an accepted claim within 14 days',
        quotes: ['Accepted claims are paid within 14 days of acceptance.'],
      },
    ],
  },
  {
    company: {
      name: 'Thornbury Lettings',
      domain: 'thornburylettings.example',
      first_seen_days: -1020,
      last_seen_days: -19,
      message_count: 37,
    },
    messages: [
      {
        key: 'thornbury-deposit',
        subject: 'End of tenancy at 14 Ashcombe Row',
        from: 'Thornbury Lettings <tenancies@thornburylettings.example>',
        received_days: -19,
        text: [
          'Dear Jamie,',
          '',
          'Thank you for returning the keys. The final inspection was carried out on 30 August and nothing was raised.',
          '',
          'Your deposit of £1,100.00 is held with the protection scheme and is returned within 10 working days of the final inspection, less any agreed deductions. No deductions apply here.',
          '',
          'We keep your tenancy file, including your identity and reference documents, for six years after the tenancy ends.',
          '',
          'Thornbury Lettings',
        ].join('\n'),
      },
    ],
    items: [
      {
        message: 'thornbury-deposit',
        kind: 'deposit',
        direction: 'owed_to_you',
        amount_minor: 110_000,
        due_days: -5,
        confidence: 'high',
        summary: 'The deposit on Ashcombe Row, five days past the date they gave',
        quotes: [
          'Your deposit of £1,100.00 is held with the protection scheme and is returned within 10 working days of the final inspection, less any agreed deductions.',
        ],
      },
      {
        message: 'thornbury-deposit',
        kind: 'data_held',
        direction: 'info',
        confidence: 'high',
        summary: 'They keep your tenancy file for six years after it ends',
        quotes: [
          'We keep your tenancy file, including your identity and reference documents, for six years after the tenancy ends.',
        ],
      },
    ],
  },
];

/** Build the fixture, deriving every evidence span from the message it cites. */
export function buildFixture(spaceId: string, principalId: string): Fixture {
  const companies: FixtureCompany[] = [];
  const items: FixtureItem[] = [];
  const messages = new Map<string, FixtureMessage>();

  for (const draft of DRAFTS) {
    const company: FixtureCompany = {
      id: newId('co'),
      space_id: spaceId,
      name: draft.company.name,
      domain: draft.company.domain,
      monthly_spend_minor: draft.company.monthly_spend_minor ?? null,
      currency: draft.company.monthly_spend_minor === undefined ? null : 'GBP',
      first_seen_at: at(draft.company.first_seen_days, 8, 30),
      last_seen_at: at(draft.company.last_seen_days, 10, 5),
      message_count: draft.company.message_count,
    };
    companies.push(company);

    const byKey = new Map<string, FixtureMessage>();
    for (const message of draft.messages) {
      const stored: FixtureMessage = {
        id: `<${message.key}.${company.domain}>`,
        subject: message.subject,
        from: message.from,
        received_at: at(message.received_days, 10, 5),
        text: message.text,
      };
      byKey.set(message.key, stored);
      messages.set(stored.id, stored);
    }

    for (const row of draft.items) {
      const message = byKey.get(row.message);
      if (!message) throw new Error(`companies fixture: no message ${row.message}`);
      const evidence = row.quotes.map((quote) => {
        const start = message.text.indexOf(quote);
        if (start < 0)
          throw new Error(
            `companies fixture: the quote "${quote.slice(0, 40)}…" is not in ${message.id}`,
          );
        return { message_id: message.id, quote, start, end: start + quote.length };
      });
      items.push({
        id: newId('li'),
        space_id: spaceId,
        principal_id: principalId,
        company_id: company.id,
        kind: row.kind,
        direction: row.direction,
        amount_minor: row.amount_minor ?? null,
        currency: row.amount_minor === undefined ? null : 'GBP',
        due_at: row.due_days === undefined ? null : at(row.due_days, 12, 0),
        status: row.status ?? 'found',
        confidence: row.confidence ?? 'medium',
        evidence,
        suggested_playbook: row.playbook ?? null,
        job_id: null,
        summary: row.summary,
      });
    }
  }

  return {
    companies,
    items,
    messages,
    currency: 'GBP',
    from_address: 'jamie.davis@fastmail.example',
  };
}

/** The six figures, counted from the items that are still live. */
export function totalsOf(fixture: Pick<Fixture, 'items' | 'companies' | 'currency'>) {
  const live = fixture.items.filter(
    (item) => item.status !== 'dropped' && item.status !== 'settled',
  );
  const inCurrency = (item: FixtureItem) =>
    item.currency === null || item.currency === fixture.currency;
  const horizon = Date.now() + 30 * DAY;
  return {
    owed_to_you_minor: live
      .filter((item) => item.direction === 'owed_to_you' && inCurrency(item))
      .reduce((sum, item) => sum + (item.amount_minor ?? 0), 0),
    monthly_spend_minor: fixture.companies.reduce(
      (sum, company) => sum + (company.monthly_spend_minor ?? 0),
      0,
    ),
    renewals_next_30d: live.filter(
      (item) =>
        item.kind === 'renewal' && item.due_at !== null && Date.parse(item.due_at) <= horizon,
    ).length,
    price_rises: live.filter((item) => item.kind === 'price_rise').length,
    trials_ending: live.filter((item) => item.kind === 'trial_ending').length,
    data_holders: new Set(
      live.filter((item) => item.kind === 'data_held').map((item) => item.company_id),
    ).size,
  };
}

/** Promises in force and promises whose date has passed, for the map's last two figures. */
export function promiseCounts(items: FixtureItem[]) {
  const now = Date.now();
  // Every promise still in play, which includes the ones being chased. A
  // promise somebody is working on is still a promise; counting only `found`
  // would tick the figure down the moment a person pressed "Handle it", which
  // reads as if the problem went away when in fact work just started on it.
  const promises = items.filter(
    (item) =>
      item.kind === 'promise' &&
      (item.status === 'found' || item.status === 'handling' || item.status === 'waiting'),
  );
  return {
    promises_in_force: promises.filter(
      (item) => item.due_at === null || Date.parse(item.due_at) >= now,
    ).length,
    promises_lapsed: promises.filter(
      (item) => item.due_at !== null && Date.parse(item.due_at) < now,
    ).length,
  };
}
