import { experienceOperations, experienceResult, unavailable } from '@melete/contracts';
import type { Hono } from 'hono';

export function mountExperienceMock(app: Hono): void {
  for (const [key, operation] of Object.entries(experienceOperations)) {
    const [method, path] = key.split(' ') as [string, string];
    app.on(method, path.replace(/\{([^}]+)\}/g, ':$1'), async (c) => {
      if ('request' in operation) {
        const parsed = operation.request.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success)
          return c.json(
            { error: { code: 'invalid_request', message: 'Check the information and try again.' } },
            400,
          );
      }
      return c.json(
        experienceResult(operation.response).parse(
          unavailable(
            path.includes('share')
              ? 'Sharing is not available yet.'
              : path.includes('browser')
                ? 'Browser tasks are not connected yet.'
                : path.includes('signin')
                  ? 'Use your password to sign in for now.'
                  : 'This experience is not available in this scenario yet.',
          ),
        ),
      );
    });
  }
}
