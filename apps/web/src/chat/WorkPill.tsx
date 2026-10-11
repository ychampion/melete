/**
 * One line over the composer while the agent works on its browser or desktop:
 * what it is doing there, in plain words, with Stop and Take over beside it.
 * Stop is the composer's own stop; Take over is the same hand-over a card
 * offers, for whichever screen the agent is on.
 */
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { CardAction } from '../experience/types.ts';
import { takeOverAction, workStep } from './live-card.ts';
import './live-card.css';

/**
 * Asks which session to take over, then takes it. With none running it shows
 * the computer, which says why; when the service could not be asked, the
 * person is told the take-over did not happen.
 */
export async function takeOverFromPill(
  conversationId: string,
  surface: 'browser' | 'computer',
  agentId: string | null,
  handlers: {
    onTakeOver: (action: CardAction) => void;
    onOpen: () => void;
    onError: (reason: string) => void;
  },
  calls: Pick<typeof adapter, 'computer' | 'sandboxComputers'> = adapter,
): Promise<void> {
  const { action, error } = await takeOverAction(conversationId, surface, agentId, calls);
  if (action) handlers.onTakeOver(action);
  else {
    if (error) handlers.onError(error);
    handlers.onOpen();
  }
}

export function WorkPill({
  turn,
  conversationId,
  agentName,
  onStop,
  onTakeOver,
  onOpen,
  onError,
  chatAgentId,
  calls = adapter,
}: {
  /** The running turn; the line shows only while it is at work on the computer. */
  turn: TranscriptTurn | null | undefined;
  conversationId: string | null;
  agentName: string;
  onStop: () => void;
  onTakeOver: (action: CardAction) => void;
  /** Shows the agent's computer. */
  onOpen: () => void;
  /** Says a take-over could not be started, with the service's reason. */
  onError: (reason: string) => void;
  /** The chat's agent: whatever agent the turn is, it works on this agent's computer. */
  chatAgentId: string | null;
  calls?: Pick<typeof adapter, 'computer' | 'sandboxComputers'>;
}) {
  const step = workStep(turn, agentName);
  if (!step || !conversationId) return null;
  const where = step.surface === 'browser' ? 'browser' : 'computer';
  return (
    <div className="work-pill" data-surface={step.surface}>
      <span className="work-pill-dot" aria-hidden="true" />
      <Icon name={step.surface === 'browser' ? 'globe' : 'monitor'} size={14} />
      <button
        type="button"
        className="work-pill-words clamp1"
        title={step.words}
        aria-label={`${step.words}. Show ${agentName}’s ${where}`}
        onClick={onOpen}
      >
        {step.words}
      </button>
      <button
        type="button"
        className="work-pill-btn"
        aria-label={`Take over the ${where}`}
        onClick={() =>
          void takeOverFromPill(
            conversationId,
            step.surface,
            chatAgentId,
            { onTakeOver, onOpen, onError },
            calls,
          )
        }
      >
        <Icon name="hand" size={14} />
        <span className="work-pill-btn-words">Take over</span>
      </button>
      <button
        type="button"
        className="work-pill-btn work-pill-stop"
        aria-label={`Stop ${agentName}`}
        title="Stop"
        onClick={onStop}
      >
        <span className="work-pill-square" aria-hidden="true" />
      </button>
    </div>
  );
}
