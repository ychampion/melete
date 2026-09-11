import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 409,
  ) {
    super(message);
  }
}
