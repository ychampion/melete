/**
 * "What the model saw" for one answer: what the person and their sources said,
 * beside exactly what went to the cloud model, with every detail the privacy
 * router swapped for a placeholder marked on both sides and named by kind.
 * The values come from this person's own Melete for this screen only, and
 * leave the page when the sheet closes.
 */
import { useEffect, useState } from 'react';
import { Badge, Dialog, Segmented, Skeleton } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { instanceName } from '../experience/instance.ts';
import type { PrivacyCategory, PrivacySeen } from '../experience/types.ts';
import './model-saw.css';

type Part = PrivacySeen['parts'][number];
type Segment = Part['segments'][number];
type Side = 'yours' | 'model';

/** One detail's kind, as a label beside it and counted in the legend. */
const KINDS: Record<PrivacyCategory, { label: string; one: string; many: string }> = {
  account: { label: 'Account number', one: 'account number', many: 'account numbers' },
  card: { label: 'Card number', one: 'card number', many: 'card numbers' },
  routing: { label: 'Routing number', one: 'routing number', many: 'routing numbers' },
  ssn: {
    label: 'Social Security number',
    one: 'Social Security number',
    many: 'Social Security numbers',
  },
  tax_id: { label: 'Tax ID', one: 'tax ID', many: 'tax IDs' },
  national_id: { label: 'National ID', one: 'national ID', many: 'national IDs' },
  passport: { label: 'Passport number', one: 'passport number', many: 'passport numbers' },
  license: { label: 'Licence number', one: 'licence number', many: 'licence numbers' },
  health: { label: 'Health detail', one: 'health detail', many: 'health details' },
  address: { label: 'Address', one: 'address', many: 'addresses' },
  phone: { label: 'Phone number', one: 'phone number', many: 'phone numbers' },
  email: { label: 'Email address', one: 'email address', many: 'email addresses' },
  dob: { label: 'Date of birth', one: 'date of birth', many: 'dates of birth' },
  credential: { label: 'Password or key', one: 'password or key', many: 'passwords or keys' },
  name: { label: 'Name', one: 'name', many: 'names' },
  private: { label: 'Private detail', one: 'private detail', many: 'private details' },
};

const SOURCES: [RegExp, string][] = [
  [/mail|inbox|imap|gmail|outlook/i, 'From your mail'],
  [/calendar|caldav|event/i, 'From your calendar'],
  [/contact/i, 'From your contacts'],
  [/drive|file|doc|note/i, 'From your files'],
  [/web|search|browse|fetch|page/i, 'From the web'],
];

/** Where a piece came from, in words. The tool's own name stays in the tooltip. */
export function sourceLabel(part: Pick<Part, 'source' | 'tool'>): string {
  if (part.source === 'you') return 'Your message';
  const tool = part.tool ?? '';
  return SOURCES.find(([pattern]) => pattern.test(tool))?.[1] ?? 'From a tool';
}

/** The legend's line: how many details were swapped, by kind. */
export function swappedSummary(categories: PrivacySeen['categories']): string {
  const total = categories.reduce((sum, entry) => sum + entry.count, 0);
  if (!total) return '';
  return `${total} detail${total === 1 ? '' : 's'} swapped for placeholders`;
}

function Mark({
  segment,
  side,
}: {
  segment: Extract<Segment, { placeholder: string }>;
  side: Side;
}) {
  const kind = KINDS[segment.category].label;
  const shown = side === 'model' ? segment.placeholder : (segment.value ?? segment.placeholder);
  return (
    <mark
      className={`saw-mark saw-mark-${side}`}
      title={segment.value === null && side === 'yours' ? `${kind}, no longer held` : kind}
    >
      {shown}
      <span className="saw-kind">{kind}</span>
    </mark>
  );
}

function Text({ part, side }: { part: Part; side: Side }) {
  return (
    <div className="saw-text">
      {part.segments.map((segment, index) =>
        'placeholder' in segment ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are fixed for the life of the sheet
          <Mark key={index} segment={segment} side={side} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are fixed for the life of the sheet
          <span key={index}>{segment.text}</span>
        ),
      )}
      {part.truncated ? (
        <span className="saw-cut">
          Shortened here to keep this readable. The model had all of it.
        </span>
      ) : null}
    </div>
  );
}

/** The pieces that still have their text. One past the history limit has none, as if never kept. */
function keptParts(seen: PrivacySeen): Part[] {
  return seen.parts.filter((part) => part.segments.length > 0);
}

function Body({ seen, side }: { seen: PrivacySeen; side: Side }) {
  const parts = keptParts(seen);
  if (!parts.length)
    return (
      <p className="saw-note">
        {seen.route === 'local' || seen.route === 'on_device'
          ? 'This answer was worked out on your own model, so nothing went to a cloud model.'
          : `${instanceName()} didn’t keep a copy of what went out for this answer. Newer answers have one.`}
      </p>
    );
  return (
    <div className="saw-grid" data-side={side}>
      <div className="saw-heads" aria-hidden="true">
        <div className="saw-head">You see</div>
        <div className="saw-head">The model saw</div>
      </div>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed for the life of the sheet
        <section key={index} className="saw-part" aria-label={sourceLabel(part)}>
          <div className="saw-source" title={part.tool ?? undefined}>
            {sourceLabel(part)}
          </div>
          <div className="saw-cell saw-yours">
            <span className="sr-only">You see: </span>
            <Text part={part} side="yours" />
          </div>
          <div className="saw-cell saw-model">
            <span className="sr-only">The model saw: </span>
            <Text part={part} side="model" />
          </div>
        </section>
      ))}
    </div>
  );
}

export function ModelSaw({
  conversationId,
  turnId,
  onClose,
}: {
  conversationId: string;
  turnId: string;
  onClose: () => void;
}) {
  const [seen, setSeen] = useState<PrivacySeen | null>(null);
  const [failed, setFailed] = useState(false);
  const [side, setSide] = useState<Side>('yours');

  useEffect(() => {
    let live = true;
    void adapter.privacySeen(conversationId, turnId).then((result) => {
      if (!live) return;
      if (result.data) setSeen(result.data);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [conversationId, turnId]);

  const swapped = seen ? swappedSummary(seen.categories) : '';
  const hasParts = !!seen && keptParts(seen).length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      width={960}
      title="What the model saw"
      sub={`What you and your sources said, beside what went to the cloud model. Shown here only, from your own ${instanceName()}.`}
    >
      {failed ? (
        <p className="saw-note">Couldn’t load this just now. Close it and try again.</p>
      ) : !seen ? (
        <div className="col" style={{ gap: 8 }}>
          <Skeleton width="70%" />
          <Skeleton width="50%" />
        </div>
      ) : (
        <>
          {hasParts ? (
            <div className="saw-legend" aria-live="polite">
              {swapped ? (
                <>
                  <span className="saw-legend-line">{swapped}</span>
                  <span className="saw-legend-kinds">
                    {seen.categories.map((entry) => (
                      <Badge key={entry.category} tone="outline">
                        {entry.count}{' '}
                        {entry.count === 1 ? KINDS[entry.category].one : KINDS[entry.category].many}
                      </Badge>
                    ))}
                  </span>
                </>
              ) : (
                <span className="saw-legend-line">
                  Nothing private was found here, so the model saw it exactly as you do.
                </span>
              )}
            </div>
          ) : null}
          {hasParts ? (
            <div className="saw-toggle">
              <Segmented
                label="Which side to show"
                value={side}
                onChange={setSide}
                options={[
                  { value: 'yours', label: 'You see' },
                  { value: 'model', label: 'The model saw' },
                ]}
              />
            </div>
          ) : null}
          <Body seen={seen} side={side} />
        </>
      )}
    </Dialog>
  );
}
