/** Match the core catalog allowance: at most 750 estimated tokens per loaded schema. */
export const MAX_TOOL_SCHEMA_BYTES = 3_000;

export function toolSchemaFits(schema: object): boolean {
  return Buffer.byteLength(JSON.stringify(schema), 'utf8') <= MAX_TOOL_SCHEMA_BYTES;
}
