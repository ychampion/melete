import { describe, expect, test } from 'bun:test';
import {
  beliefCategoryOf,
  beliefLabel,
  beliefTrustOf,
  describeSource,
  type SourceFacts,
  sourceKind,
  subjectLabel,
} from './beliefs.ts';

const at = '2026-03-03T15:00:00Z';
const fact = (over: Partial<SourceFacts>): SourceFacts => ({
  publisher: 'chat',
  stream: 'chat',
  source_type: 'message',
  author: 'owner',
  event_at: at,
  ...over,
});

describe('where a belief came from, in plain words', () => {
  test.each([
    [fact({}), 'chat', 'you told me in chat, Mar 3'],
    [
      fact({ publisher: 'experience', stream: 'onboarding' }),
      'setup',
      'you told me during setup, Mar 3',
    ],
    [
      fact({ publisher: 'experience', stream: 'owner-corrections' }),
      'correction',
      'you corrected this, Mar 3',
    ],
    [
      fact({ source_type: 'owner_edit', publisher: 'git' }),
      'correction',
      'you corrected this, Mar 3',
    ],
    [fact({ publisher: 'experience', stream: 'import' }), 'import', 'you imported this, Mar 3'],
    [
      fact({ publisher: 'authenticated-principal', stream: 'gmail', source_type: 'observation' }),
      'email',
      'from your email, Mar 3',
    ],
    [
      fact({
        publisher: 'authenticated-principal',
        stream: 'mail.inbox',
        author: 'external',
      }),
      'email',
      'from an email someone sent you, Mar 3',
    ],
    [
      fact({ publisher: 'authenticated-principal', stream: 'caldav', source_type: 'observation' }),
      'calendar',
      'from your calendar, Mar 3',
    ],
    [
      fact({
        publisher: 'authenticated-principal',
        stream: 'contacts',
        source_type: 'observation',
      }),
      'contacts',
      'from your contacts, Mar 3',
    ],
    [
      fact({ publisher: 'authenticated-principal', stream: 'bank', source_type: 'receipt' }),
      'receipt',
      'from a receipt, Mar 3',
    ],
    [
      fact({ publisher: 'authenticated-principal', stream: 'bank', source_type: 'observation' }),
      'connected',
      'from an account you connected, Mar 3',
    ],
    [
      fact({ publisher: 'authenticated-principal', stream: 'notes', source_type: 'document' }),
      'document',
      'from a document, Mar 3',
    ],
    [
      fact({ publisher: 'authenticated-principal', stream: 'assistant-notes' }),
      'assistant',
      'an assistant you connected saved this, Mar 3',
    ],
    [
      fact({ source_type: 'assistant', publisher: 'job-worker' }),
      'worked_out',
      'I worked this out, Mar 3',
    ],
    [fact({ author: 'external' }), 'message', 'from a message someone sent you, Mar 3'],
  ])('%o is %s: "%s"', (source, kind, text) => {
    expect(sourceKind(source)).toBe(kind as ReturnType<typeof sourceKind>);
    expect(describeSource(source, 'UTC')).toBe(text);
  });

  test('the date is the day in the person’s own time zone', () => {
    const late = fact({ event_at: '2026-03-03T23:30:00Z' });
    expect(describeSource(late, 'UTC')).toBe('you told me in chat, Mar 3');
    expect(describeSource(late, 'Asia/Kolkata')).toBe('you told me in chat, Mar 4');
    expect(describeSource(late, 'America/Los_Angeles')).toBe('you told me in chat, Mar 3');
  });
});

describe('trust a person reads', () => {
  test('the weakest source decides it, and a conclusion stays a guess', () => {
    expect(beliefTrustOf('owner')).toBe('yours');
    expect(beliefTrustOf('verified_connector')).toBe('connected');
    expect(beliefTrustOf('external_content')).toBe('outside');
    expect(beliefTrustOf('inferred')).toBe('worked_out');
    expect(beliefTrustOf('unknown')).toBe('worked_out');
    expect(beliefTrustOf('owner', 'inferred')).toBe('worked_out');
  });
});

describe('grouping', () => {
  const group = (
    domainKey: string,
    content = '',
    key: string | null = null,
    kind = 'user_statement',
  ) => beliefCategoryOf({ key, domainKey, kind, content });
  test('registry keys decide first', () => {
    expect(group('contact.maya.email', '', 'contact.maya.email')).toBe('people');
    expect(group('pref.coffee.order', '', 'pref.coffee.order')).toBe('preferences');
    expect(group('event.dentist.date', '', 'event.dentist.date')).toBe('routines');
  });
  test('then the subject, then the words of the belief', () => {
    expect(group('person.maya.birthday', 'March 3')).toBe('people');
    expect(group('billing.electricity', '$84 a month')).toBe('accounts');
    expect(group('work.employer', 'Designer at a studio')).toBe('work');
    expect(group('routine.gym', 'Tuesdays at 7am')).toBe('routines');
    expect(group('food.likes', 'Thai food')).toBe('preferences');
    expect(group('misc.fact', 'Pays rent on the 1st')).toBe('accounts');
    expect(group('misc.fact', 'Likes window seats', null, 'preference')).toBe('preferences');
    expect(group('misc.fact', 'The car is blue')).toBe('other');
  });
  test('a receipt is about accounts and bills', () => {
    expect(
      beliefCategoryOf({
        key: null,
        domainKey: 'streaming.plan',
        kind: 'checked_fact',
        content: '$13.99',
        sourceKinds: ['receipt'],
      }),
    ).toBe('accounts');
  });
});

describe('labels', () => {
  test('a registry key reads as a name', () => {
    expect(subjectLabel('contact.maya.email', 'contact.maya.email')).toBe("Maya's email");
    expect(subjectLabel('pref.coffee.order', 'pref.coffee.order')).toBe('Coffee: order');
  });
  test('a subject reads as words, with the person first when it names one', () => {
    expect(subjectLabel(null, 'person.maya.birthday')).toBe("Maya's birthday");
    expect(subjectLabel(null, 'fact.home_city')).toBe('Home city');
    expect(subjectLabel(null, 'work.employer')).toBe('Work employer');
    expect(subjectLabel(null, 'pref.tea:exception:2026-01-01:2026-01-02')).toBe('Tea');
  });
  test('a relation and a name read as one person, never as a key', () => {
    // Labels a memory page showed in real use: "Sister's lena city", "Landlord's patel",
    // "Pref diet shellfish allergy".
    expect(subjectLabel(null, 'person.sister.lena.city')).toBe("Sister Lena's city");
    expect(subjectLabel(null, 'person.landlord.patel')).toBe('Landlord Patel');
    expect(subjectLabel(null, 'person.sister.city')).toBe("Sister's city");
    expect(subjectLabel(null, 'pref.diet.shellfish_allergy')).toBe('Diet shellfish allergy');
  });
  test("a belief's own line is its sentence, and its subject when the detail is a bare value", () => {
    expect(beliefLabel(null, 'person.sister.lena.city', 'Sister Lena lives in Seattle.')).toBe(
      'Sister Lena lives in Seattle',
    );
    expect(beliefLabel(null, 'person.lena', "Lena, the user's sister, lives in Seattle")).toBe(
      'Lena, your sister, lives in Seattle',
    );
    expect(beliefLabel(null, 'person.lena.birthday', "The user's sister was born March 3")).toBe(
      'Your sister was born March 3',
    );
    // A keyed value and a short value keep their subject.
    expect(beliefLabel('pref.travel.seat', 'pref.travel.seat', 'aisle seat on long flights')).toBe(
      'Travel: seat',
    );
    expect(beliefLabel(null, 'person.lena.birthday', 'March 3')).toBe("Lena's birthday");
    expect(beliefLabel(null, 'notes.long', 'word '.repeat(40))).toBe('Notes long');
  });
});
