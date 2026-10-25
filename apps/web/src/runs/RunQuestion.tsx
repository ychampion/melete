/**
 * The question long work stopped to ask, answered on the work's own page with
 * the answers it offered. It is the same question Home's queue holds, drawn
 * with the chat's question card and answered through the same call.
 */
import { Questionnaire } from '../chat/parts.tsx';
import { adapter } from '../experience/adapter.ts';
import { useInFlight } from '../experience/decide.ts';
import { useApp } from '../experience/hooks.ts';
import type { Question, Run } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

/** The open question this work asked, when it offered answers to press. */
export function questionOfRun(
  run: Pick<Run, 'id'>,
  questions: readonly Question[],
): Question | null {
  return (
    questions.find((question) => question.conversation_id === run.id && question.options.length) ??
    null
  );
}

export function RunQuestion({
  question,
  onAnswered,
}: {
  question: Question;
  onAnswered?: () => void;
}) {
  const { refreshConversations } = useApp();
  const flight = useInFlight();
  const answer = (optionId: string) =>
    void flight.run(question.id, async () => {
      const result = await adapter.answer(question.id, optionId);
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer' });
        return;
      }
      refreshConversations();
      onAnswered?.();
    });
  return (
    <Questionnaire
      question={question}
      answered={null}
      active
      busy={flight.has(question.id)}
      // Words of the person's own go in the reply box under it.
      own={false}
      onAnswer={answer}
      onOwn={() => {}}
    />
  );
}
