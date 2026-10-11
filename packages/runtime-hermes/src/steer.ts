/**
 * Words the person sends while a turn is running.
 *
 * They reach the model at the next step's end, appended to that step's
 * result, or, when the run ends first, as the input of the next run in the
 * same attempt. Either way the model is told who said them and that the work
 * goes on: they change the task, they do not start a new one.
 */
import type { SteerMessage } from '@melete/contracts';

/** What a run in progress is handed: the person's words, marked as theirs. */
export function steerInput(messages: readonly SteerMessage[]): string {
  const said = messages.map((message) => message.text.trim()).filter(Boolean);
  return [
    `The person just added${said.length > 1 ? ' these messages' : ''} while you were working:`,
    ...said.map((text) => `> ${text.replaceAll('\n', '\n> ')}`),
    'Take this into account and carry on with the task; change course if it asks you to.',
  ].join('\n');
}

/**
 * The next run's input when the person's words arrived after the run had
 * read its last step. What it already wrote is shown, so the reply that
 * follows replaces it with one that takes the new words into account.
 */
export function steerContinuation(messages: readonly SteerMessage[], said: string): string {
  return [
    steerInput(messages),
    ...(said.trim()
      ? [
          '',
          'You had already written this reply, which the person has not been sent:',
          ...said
            .trim()
            .split('\n')
            .map((line) => `> ${line}`),
          'Write your whole reply again, taking their new words into account.',
        ]
      : []),
  ].join('\n');
}
