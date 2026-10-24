/**
 * Whether the agent still holds a skill it was given in full.
 *
 * An attempt starts with its chosen skills written out in its input
 * (`renderSkills` in the runtime), so reading one again through `skills.read`
 * only repeats words it has. That stops being true inside a long turn: the
 * engine compacts the conversation in place, and its summary can leave the
 * skill out. A skill changed since the attempt started is also not the one the
 * agent holds. So a read is answered with a pointer only when the agent's
 * latest request carried that skill's current text whole; otherwise it gets the
 * skill in full.
 *
 * The runner says which skills an attempt was given; the gateway looks at each
 * request the agent itself sends (one that carries its tools, so not the
 * engine's summary call). All of it is held in memory for attempts that are
 * running; an attempt it does not follow reads its skills in full.
 */

/** How many attempts are followed at most; far more than run at once. */
const KEPT = 1_000;

type Followed = {
  /** Each skill given in full, by name: its text, and how it reads inside a request's JSON. */
  given: Map<string, { body: string; quoted: string }>;
  /** The skills the agent's latest request carried whole. */
  held: Set<string>;
};

const attempts = new Map<string, Followed>();

/** The attempt starts with these skills written out in full. */
export function skillsGiven(
  attemptId: string,
  skills: readonly { readonly name: string; readonly body: string }[],
): void {
  const given = new Map<string, { body: string; quoted: string }>();
  for (const skill of skills) {
    const text = skill.body.trim();
    // An empty skill would be found in any request.
    if (text)
      given.set(skill.name, { body: skill.body, quoted: JSON.stringify(text).slice(1, -1) });
  }
  if (!given.size) {
    attempts.delete(attemptId);
    return;
  }
  attempts.set(attemptId, { given, held: new Set() });
  if (attempts.size > KEPT) {
    const [oldest] = attempts.keys();
    if (oldest) attempts.delete(oldest);
  }
}

/** A request the attempt is sending: which given skills it carries whole. */
export function skillsSent(attemptId: string, body: Record<string, unknown>): void {
  const followed = attempts.get(attemptId);
  if (!followed) return;
  // The agent's own requests carry its tools; a side call such as the engine's
  // compaction summary says nothing about what the agent holds.
  if (!Array.isArray(body.tools) || !body.tools.length) return;
  // Searched as JSON: a skill's text is escaped the same way wherever it sits.
  const sent = JSON.stringify(body);
  followed.held = new Set(
    [...followed.given].filter(([, skill]) => sent.includes(skill.quoted)).map(([name]) => name),
  );
}

/** The agent's latest request carried this skill, at this exact text, whole. */
export function stillGiven(attemptId: string, name: string, body: string): boolean {
  const followed = attempts.get(attemptId);
  return Boolean(followed?.held.has(name) && followed.given.get(name)?.body === body);
}

export function skillsDone(attemptId: string): void {
  attempts.delete(attemptId);
}
