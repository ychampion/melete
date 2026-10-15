/**
 * The line a failed request leaves in the log. A failed database query names its
 * bound values after `params:`, and the driver's own message can quote one, so
 * neither is written: the query text, which holds placeholders, and the
 * database error code are enough to find the cause.
 */
export function requestFailureText(error: Error): string {
  const text = error.message.replace(/\nparams: [\s\S]*$/, '');
  const cause: unknown = error.cause;
  const code =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? ` (database error ${cause.code})`
      : '';
  return `${text}${code}`;
}
