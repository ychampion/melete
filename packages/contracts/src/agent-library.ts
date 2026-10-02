/**
 * What adding an agent from the library does after the agent itself is made,
 * shared by every client so they all do it the same way: the starter routine
 * is only offered, and becomes a routine for that agent when the person says
 * so; each answer to a getting-to-know-you question is saved as the person's
 * own statement on the question's `pref.<purpose>.<name>` key.
 */

type Question = { id: string; question: string; memory_key: string };
type Routine = { title: string; instruction: string; weekdays: number[]; at: string };

/** The routine to create for a new agent, once the person has said yes to it. */
export function libraryRoutine(routine: Routine, agentId: string) {
  return {
    title: routine.title,
    instruction: routine.instruction,
    weekdays: [...routine.weekdays],
    at: routine.at,
    agent_id: agentId,
  };
}

/** The saved details for the answers given; a question left blank saves nothing. */
export function libraryAnswers(questions: Question[], answers: Record<string, string>) {
  return questions.flatMap((question) => {
    const value = (answers[question.id] ?? '').trim().slice(0, 4000);
    if (!value) return [];
    return [
      {
        key: question.memory_key,
        value,
        statement: `${question.question} ${value}`,
      },
    ];
  });
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** "Weekdays at 7:30 AM", "Sundays at 5:00 PM", in the person's own time. */
export function libraryScheduleWords(routine: Pick<Routine, 'weekdays' | 'at'>): string {
  const days = [...new Set(routine.weekdays)].sort((a, b) => a - b);
  const key = days.join(',');
  const when =
    key === '0,1,2,3,4,5,6'
      ? 'Every day'
      : key === '1,2,3,4,5'
        ? 'Weekdays'
        : key === '0,6'
          ? 'Weekends'
          : days.map((day) => DAYS[day]).join(', ');
  const [hour = 0, minute = 0] = routine.at.split(':').map(Number);
  const clock = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${when} at ${clock}`;
}

type Kind = 'mail' | 'calendar' | 'files' | 'web' | 'browser' | 'computer' | 'devices' | 'mcp';

/** What a connection is, in the library's words, from the app name the service gives it. */
export function kindsOfApp(app: string): Kind[] {
  const name = app.toLowerCase();
  if (/mail|outlook|imap|smtp/.test(name)) return ['mail'];
  if (/calendar|caldav|\bics\b/.test(name)) return ['calendar'];
  if (/^files$|drive/.test(name)) return ['files'];
  if (name === 'web') return ['web'];
  if (/browser/.test(name)) return ['browser'];
  if (name === 'computer') return ['computer', 'devices'];
  if (/^(speech|transcription|test connection)$/.test(name)) return [];
  return ['mcp'];
}

/**
 * The person's connected connections that match what a template works best
 * with. A draft starts with these ticked, so the person sees exactly what the
 * agent will reach and can untick any before creating it.
 */
export function suggestedConnections(
  kinds: readonly string[],
  connections: readonly { id: string; app: string; status: string }[],
): string[] {
  return connections
    .filter((connection) => connection.status === 'connected')
    .filter((connection) => kindsOfApp(connection.app).some((kind) => kinds.includes(kind)))
    .map((connection) => connection.id);
}
