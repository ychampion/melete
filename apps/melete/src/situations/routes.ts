import { deadlineResponse, documentDeadlineRequest } from '@melete/contracts';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { driveFileId } from '../connectors/google-drive.ts';
import { mcpActorOf } from '../mcp-server/actor.ts';
import type { SituationService } from './service.ts';

/** What Melete noticed for the signed-in person. Every route is the caller's own. */
export function mountSituations(app: Hono, service: SituationService) {
  app.get('/situations', async (c) =>
    c.json({ situations: await service.list(c.get('owner').id) }),
  );
  /**
   * A deadline on a Drive file, for the signed-in person, in the space of the
   * account it names, which must be a space they use. Set by the person, it
   * may reach them at any hour near its time; set by an assistant they
   * connected, it is shown and never urgent.
   */
  app.post('/situations/deadlines', async (c) => {
    const parsed = documentDeadlineRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ServiceError(
        'invalid_request',
        'A deadline needs an account, a file, a title and a time.',
        400,
      );
    const request = parsed.data;
    const fileId = driveFileId(request.file);
    if (!fileId)
      throw new ServiceError('invalid_request', 'That is not a Google Drive file id or link.', 400);
    const principalId = c.get('owner').id;
    const spaceId = await service.usableSpaceOf(request.connection_id, principalId);
    if (!spaceId)
      throw new ServiceError(
        'invalid_deadline',
        'That is not something this person can keep a deadline on.',
        400,
      );
    const dueAt = new Date(request.due_at);
    if (dueAt.getTime() <= service.currentTime())
      throw new ServiceError('invalid_deadline', 'The deadline has already passed.', 400);
    const kept = await service.setDocumentDeadline({
      spaceId,
      principalId,
      connectionId: request.connection_id,
      fileId,
      title: request.title,
      dueAt,
      leadSeconds: request.lead_seconds,
      ...(request.since ? { since: new Date(request.since) } : {}),
      by: request.by,
      personSet: !mcpActorOf(c.env),
      jobId: request.job_id ?? null,
    });
    return c.json(
      deadlineResponse.parse({
        deadline: {
          id: kept.id,
          subject_key: kept.subjectKey,
          title: kept.title,
          due_at: kept.dueAt.toISOString(),
          fire_at: kept.fireAt.toISOString(),
          person_set: kept.personSet,
          state: kept.state,
        },
      }),
      201,
    );
  });
  app.post('/situations/:id/ack', async (c) =>
    c.json({ situation: await service.ack(c.get('owner').id, c.req.param('id')) }),
  );
  app.post('/situations/:id/dismiss', async (c) =>
    c.json({ situation: await service.dismiss(c.get('owner').id, c.req.param('id')) }),
  );
}
