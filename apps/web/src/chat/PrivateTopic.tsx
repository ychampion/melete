/**
 * Under the chat header, when this conversation is treated as private because
 * of what the person wrote in it: which topic, and a way to say it is not.
 * Clearing it is the person's call; Melete does not judge the conversation
 * again afterwards.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import type { SensitiveTopic } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const TOPIC_WORDS: Record<SensitiveTopic, string> = {
  therapy: 'therapy or mental health',
  health: 'health or medical records',
  finance: 'personal finances',
};

export function PrivateTopic({
  conversationId,
  refresh,
}: {
  conversationId: string | null;
  /** Read again when this changes, e.g. when a turn finishes. */
  refresh: string;
}) {
  const [topic, setTopic] = useState<SensitiveTopic | null>(null);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` only asks for a fresh read.
  useEffect(() => {
    setTopic(null);
    if (!conversationId) return;
    let live = true;
    void adapter.conversationPrivacy(conversationId).then((result) => {
      if (live) setTopic(result.data?.sensitive ?? null);
    });
    return () => {
      live = false;
    };
  }, [conversationId, refresh]);

  if (!conversationId || !topic) return null;

  const clear = async () => {
    setBusy(true);
    const result = await adapter.markConversationPrivacy(conversationId, null);
    setBusy(false);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t change that' });
      return;
    }
    setTopic(result.data.sensitive);
    toast({
      kind: 'ok',
      title: 'This chat is no longer kept private',
      sub: 'Details like account numbers are still swapped out before the cloud model sees them.',
    });
  };

  return (
    <div className="private-topic row" role="status">
      <Icon name="lock" size={12} />
      <span className="grow">
        Kept private: this chat looks like it is about {TOPIC_WORDS[topic]}.
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={busy}
        onClick={() => void clear()}
      >
        It isn’t
      </button>
    </div>
  );
}
