import { z } from 'zod';
import { jsonObject } from './common.ts';
import { execRecord } from './execution.ts';

/** Additive proposal form: reserve arguments before the cell starts a command. */
export const executionIntent = z.object({ intent: jsonObject }).strict();
export const executionStartResponse = z.object({ execute: z.boolean() });
export const executionSettlement = z.union([
  z.object({ record: execRecord }).strict(),
  z.object({ error: z.string().min(1).max(2000) }).strict(),
]);
export type ExecutionSettlement = z.infer<typeof executionSettlement>;
