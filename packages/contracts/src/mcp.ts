import { z } from 'zod';
import { effectClass } from './broker.ts';

export const mcpHttpUrl = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    ['http:', 'https:'].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.hash
  );
}, 'MCP endpoint must be HTTP(S), without credentials or fragments');

const scope = z.string().min(1).max(160);
/** The operator declares authority; server annotations and tool arguments cannot grant it. */
export const mcpOperatorPolicy = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(40),
    allowed_scopes: z.array(scope).min(1).max(64),
    audience: z.literal('owner'),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
            alias: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .max(80),
            required_scopes: z.array(scope).min(1).max(32),
            effect_class: effectClass.default('write_external'),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const field of ['name', 'alias'] as const) {
      if (new Set(config.tools.map((tool) => tool[field])).size !== config.tools.length)
        ctx.addIssue({ code: 'custom', message: `MCP tool ${field} must be unique` });
    }
    for (const tool of config.tools) {
      if (!tool.required_scopes.every((item) => config.allowed_scopes.includes(item)))
        ctx.addIssue({ code: 'custom', message: 'MCP tool scopes exceed operator allowed_scopes' });
    }
  });

/** Runtime installation accepts HTTP only; stdio requires an isolated operator launcher. */
export const mcpConnectionConfig = mcpOperatorPolicy.safeExtend({ url: mcpHttpUrl });
