/**
 * A reply that asks the owner for a go-ahead is only honest if something was
 * proposed: the broker asks the owner about a proposed action, and nobody can
 * approve prose. This decides, without a model, whether an attempt ended by
 * asking permission for an external effect it never proposed.
 *
 * Structure first. The question matters only when the catalog offers an
 * external effect (`write_external` or `spend`) and none was called in this
 * attempt. A sentence then counts when it asks permission and either names the
 * verb of such an uncalled tool that has a destination (`send` for
 * `email.send`, `restart` for `server.restart`), or the attempt called a
 * reversible tool whose namespace has that uncalled external sibling (a draft
 * beside its send). Carrying out an approved action counts as proposing, but
 * the broker's own lifecycle operations name no destination and so lend no
 * verb: `resume_action` must not make "action" an effect verb.
 *
 * The permission pattern is deliberately small: `shall/should/may/can/could I`,
 * `(would|do) you (like|want) me to`, `want me to`, `ok to`, `go ahead`,
 * `proceed`, `let me know if/whether I should` or `you'd like me to`, `please
 * approve/confirm`, `once/if you approve/confirm`, and `your approval/go-ahead/
 * confirmation/permission`. A closing offer names no effect verb and so never
 * counts; neither does a question about which value to use.
 */
import type { ToolSpec } from '@melete/contracts';

const PERMISSION =
  /\b(?:shall|should|may|can|could) i\b|\b(?:would|do) you (?:like|want) me to\b|\bwant me to\b|\b(?:ok|okay|alright|all right) (?:for me )?to\b|\bgo ahead\b|\bproceed\b|\blet me know (?:if|whether|when) (?:i should|you(?:'d| would)? (?:like|want) me to)\b|\bplease (?:approve|confirm)\b|\b(?:once|if|when) you (?:approve|confirm)\b|\byour (?:approval|go-ahead|confirmation|permission)\b/i;

const EXTERNAL = new Set(['write_external', 'spend']);

const namespace = (name: string) => (name.includes('.') ? name.slice(0, name.indexOf('.')) : null);

/** The verb a tool name leads with: the first word of its last dotted segment. */
function verbs(name: string): string[] {
  const last = name.slice(name.lastIndexOf('.') + 1);
  const words = last.split(/[_\-\s]+/).filter((word) => /^[a-z]{3,}$/i.test(word));
  return name.includes('.') ? words.slice(0, 1) : words;
}

export function asksWithoutProposing(
  reply: string,
  called: readonly string[],
  catalog: readonly ToolSpec[],
): boolean {
  const external = catalog.filter((tool) => EXTERNAL.has(tool.effect_class));
  if (external.some((tool) => called.includes(tool.name))) return false;
  if (external.length === 0) return false;
  const drafted = catalog.some(
    (tool) =>
      tool.effect_class === 'write_reversible' &&
      called.includes(tool.name) &&
      namespace(tool.name) !== null &&
      external.some((other) => namespace(other.name) === namespace(tool.name)),
  );
  // Only a tool that names a destination lends its verb to a sentence. The
  // broker's own lifecycle operations name none, and `resume_action` would
  // otherwise make "action" an effect verb in ordinary English.
  const effectVerbs = external
    .filter((tool) => tool.connection_id !== null)
    .flatMap((tool) => verbs(tool.name));
  return reply
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (sentence) =>
        PERMISSION.test(sentence) &&
        (drafted || effectVerbs.some((verb) => new RegExp(`\\b${verb}`, 'i').test(sentence))),
    );
}

/** The one continuation an attempt gets when it asked for a go-ahead and proposed nothing. */
export const UNPROPOSED_CONTINUATION =
  'You asked the owner for a go-ahead, but you proposed nothing, so there is nothing to approve. ' +
  'Call the tool now: the broker will ask the owner before anything leaves. ' +
  'If you cannot, say so plainly instead of asking.';
