/**
 * What a person reads when a conversation turn reaches one of its safety
 * limits. The limit's own name stays on the attempt record for operators; the
 * conversation gets a sentence that says what happened and what to do next.
 */
export const LIMIT_REACHED_NOTE =
  'This is taking longer than expected. I\'ve saved my progress; say "continue" and I\'ll carry on.';
