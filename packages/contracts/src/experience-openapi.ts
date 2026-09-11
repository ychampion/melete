import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { experienceOperations, experienceResult } from './experience.ts';

export function experiencePaths(): ZodOpenApiPathsObject {
  const paths: ZodOpenApiPathsObject = {};
  for (const [key, operation] of Object.entries(experienceOperations)) {
    const [method, path] = key.split(' ') as [string, string];
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1], z.string()]);
    const response = experienceResult(operation.response);
    const content = {
      'application/json': { schema: response },
      ...('stream' in operation
        ? {
            'text/event-stream': {
              schema: z.string(),
              example: 'id: 42\nevent: say\ndata: {"seq":42}\n\n',
            },
          }
        : {}),
    };
    paths[path] ??= {};
    Object.assign(paths[path], {
      [method.toLowerCase()]: {
        tags: ['experience'],
        summary: key,
        description:
          'Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.',
        requestParams: {
          ...(params.length ? { path: z.object(Object.fromEntries(params)) } : {}),
          ...('query' in operation ? { query: operation.query } : {}),
          ...('stream' in operation
            ? { header: z.object({ 'Last-Event-ID': z.string().optional() }) }
            : {}),
        },
        ...('request' in operation
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: operation.request } },
              },
            }
          : {}),
        responses: { '200': { description: 'Outcome or unavailable capability', content } },
      },
    });
  }
  return paths;
}
