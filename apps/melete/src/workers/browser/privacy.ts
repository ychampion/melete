import type { JsonObject, JsonValue, RuntimeEvent } from '@melete/contracts';

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const UUID = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
const IDENTIFIERS: Record<string, RegExp> = {
  action_id: new RegExp(`^act_${ULID}$`),
  approval_id: new RegExp(`^apr_${ULID}$`),
  artifact_id: new RegExp(`^art_${ULID}$`),
  connection_id: new RegExp(`^conn_${ULID}$`),
  job_id: new RegExp(`^job_${ULID}$`),
  space_id: new RegExp(`^sp_${ULID}$`),
  session_id: new RegExp(`^brws_${UUID}$`),
  observation_id: new RegExp(`^obs_${UUID}$`),
  id: new RegExp(`^obs_${UUID}$`),
};
const CONTAINERS = new Set(['receipt', 'detail', 'observation', 'tree', 'screenshot', 'result']);
const STATUSES = new Set([
  'proposed',
  'needs_approval',
  'approved',
  'denied',
  'admitted',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'unresolved',
]);
const BOOLEAN_METADATA = new Set(['late', 'changed', 'requires_approval']);

export function isBrowserTool(tool: unknown): boolean {
  return typeof tool === 'string' && tool.trim().toLowerCase().startsWith('browser.');
}

function object(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only handles and bounded control metadata survive; arbitrary text is never an episode. */
function metadata(source: JsonObject, depth = 0): JsonObject {
  const saved: JsonObject = {};
  if (depth > 6) return saved;
  for (const [key, value] of Object.entries(source)) {
    const identifier = Object.hasOwn(IDENTIFIERS, key) ? IDENTIFIERS[key] : undefined;
    if (identifier && typeof value === 'string' && identifier.test(value)) {
      saved[key] = value;
    } else if (
      key === 'control_epoch' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      saved[key] = value;
    } else if (
      (key === 'status' || key === 'outcome') &&
      typeof value === 'string' &&
      STATUSES.has(value)
    ) {
      saved[key] = value;
    } else if (BOOLEAN_METADATA.has(key) && typeof value === 'boolean') {
      saved[key] = value;
    } else if (CONTAINERS.has(key) && object(value)) {
      const nested = metadata(value, depth + 1);
      if (Object.keys(nested).length) saved[key] = nested;
    }
  }
  return saved;
}

/**
 * Redact only the copy entering persistence. Execution and approval still receive
 * their original bytes. The result's browser identity comes from durable proposals,
 * never from a runtime-provided result label or a process-local call map.
 */
export function browserEventForPersistence(value: RuntimeEvent, browserCall = false): RuntimeEvent {
  if (value.type === 'tool_call_proposed' && isBrowserTool(value.tool)) {
    return { ...value, arguments: { redacted: true } };
  }
  if (value.type === 'tool_result' && browserCall) {
    return { ...value, result: { redacted: true, ...metadata(value.result) } };
  }
  return value;
}
