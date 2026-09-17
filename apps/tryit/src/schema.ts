/**
 * The case file: the only shape the model is allowed to return, and the shape
 * the page renders. The JSON schema below goes to the model as a strict
 * structured output; `validate.ts` checks the same shape again in code,
 * because a schema the model filled in is still the model's word for it.
 *
 * Amounts are minor units (cents, pence, paise) with an ISO 4217 currency, the
 * same way the product's ledger carries money.
 */

export type BasisSource =
  /** `alsoEvidence` when this same sentence is already shown under the evidence. */
  | { kind: 'quote'; quote: string; start: number; end: number; alsoEvidence: boolean }
  | { kind: 'url'; url: string; title: string | null };

export type Basis = { claim: string; source: BasisSource };

export type Evidence = { quote: string; start: number; end: number; why: string };

export type Odds = { level: 'high' | 'medium' | 'low'; why: string; expectedDays: number };

export type LadderStep = { dayOffset: number; step: string };

export type CaseFile = {
  company: string;
  issue: string;
  entitlement: {
    summary: string;
    amountMinor: number | null;
    currency: string | null;
    basis: Basis[];
  };
  evidence: Evidence[];
  /** Set when nothing the model quoted was actually in the paste. */
  noEvidenceNote: string | null;
  odds: Odds;
  message: { subject: string; body: string };
  ladder: LadderStep[];
  meleteNext: string;
};

/** What the model returns before the gates run. Quotes are unverified here. */
export type DraftCaseFile = {
  company: string;
  issue: string;
  entitlement: {
    summary: string;
    amount_minor: number | null;
    currency: string | null;
    basis: Array<{
      claim: string;
      source_kind: 'quote' | 'url';
      quote: string | null;
      url: string | null;
      title: string | null;
    }>;
  };
  evidence: Array<{ quote: string; why: string }>;
  odds: { level: 'high' | 'medium' | 'low'; why: string; expected_days: number };
  message: { subject: string; body: string };
  ladder: Array<{ day_offset: number; step: string }>;
  melete_next: string;
};

export const MAX_EVIDENCE = 5;
export const MAX_BASIS = 4;
export const MAX_LADDER = 5;

const nullableString = { type: ['string', 'null'] } as const;

/**
 * The structured output sent as `text.format`. Every property is required and
 * every object closed, which strict mode demands; anything optional is a
 * nullable type instead. Counts and lengths are asked for in the descriptions
 * and enforced in code, because the strict subset does not take `minItems`,
 * `maxItems`, `minLength` or `maxLength`.
 */
export const CASE_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'company',
    'issue',
    'entitlement',
    'evidence',
    'odds',
    'message',
    'ladder',
    'melete_next',
  ],
  properties: {
    company: {
      type: 'string',
      description: 'The company the person is dealing with, as they would name it.',
    },
    issue: {
      type: 'string',
      description: 'The problem in one plain sentence a parent would understand.',
    },
    entitlement: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'amount_minor', 'currency', 'basis'],
      properties: {
        summary: {
          type: 'string',
          description: 'What the person is entitled to, in one sentence.',
        },
        amount_minor: {
          type: ['integer', 'null'],
          description:
            'The amount in minor units (cents, pence, paise) when it is stated in the text or can be worked out from it. Null when it cannot.',
        },
        currency: {
          type: ['string', 'null'],
          description:
            'ISO 4217 code for the amount, such as USD, GBP, EUR, INR. Null with no amount.',
        },
        basis: {
          type: 'array',
          description:
            'One to four reasons the person is entitled to this. Each carries its own source.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'source_kind', 'quote', 'url', 'title'],
            properties: {
              claim: { type: 'string', description: 'The reason in one short sentence.' },
              source_kind: {
                type: 'string',
                enum: ['quote', 'url'],
                description:
                  'quote: the company said it in the pasted text. url: a page you actually opened with web search.',
              },
              quote: {
                ...nullableString,
                description:
                  'When source_kind is quote: the sentence copied word for word from the pasted text, at least a dozen characters. Never paraphrase it. Null otherwise.',
              },
              url: {
                ...nullableString,
                description:
                  'When source_kind is url: the exact address of a page you opened with the web search tool, the company policy page or an official regulator page. Never a URL you did not open. Null otherwise.',
              },
              title: {
                ...nullableString,
                description: 'The page title for a url source, else null.',
              },
            },
          },
        },
      },
    },
    evidence: {
      type: 'array',
      description:
        'Up to five sentences copied word for word from the pasted text that prove the issue. Never paraphrase, never repair spelling, never join two sentences. If the text proves nothing, return an empty array.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'why'],
        properties: {
          quote: {
            type: 'string',
            description: 'Word for word from the pasted text, copied exactly, one sentence.',
          },
          why: { type: 'string', description: 'What this sentence proves, in a few words.' },
        },
      },
    },
    odds: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'why', 'expected_days'],
      properties: {
        level: { type: 'string', enum: ['high', 'medium', 'low'] },
        why: { type: 'string', description: 'One sentence on why the odds are what they are.' },
        expected_days: {
          type: 'integer',
          description:
            'Realistic days until this is settled, from experience of how such cases go.',
        },
      },
    },
    message: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'body'],
      properties: {
        subject: { type: 'string', description: 'A subject line under eighty characters.' },
        body: {
          type: 'string',
          description:
            'The message the person sends, in their own first person voice. Polite, firm, short, under two hundred words. It quotes the company back to itself. No threats, no legal advice, no claim about the law beyond naming a published policy or regulation. Sign off with a plain line, never a made-up name.',
        },
      },
    },
    ladder: {
      type: 'array',
      description:
        'Three to five steps, in order, each one sentence, each with the day it happens on.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day_offset', 'step'],
        properties: {
          day_offset: {
            type: 'integer',
            description: 'Days from today. The first step is 0.',
          },
          step: { type: 'string', description: 'What happens on that day, in one sentence.' },
        },
      },
    },
    melete_next: {
      type: 'string',
      description:
        'One or two sentences on what Melete would do from here if it were running this for the person: send from their address once they say yes, wait for the reply, follow up, escalate, stop when settled.',
    },
  },
} as const;
