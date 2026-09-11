import { notificationDelivery } from '@melete/contracts';
import type { Hono } from 'hono';
import { notificationView, obligationView, type ReplyService } from '../jobs/replies.ts';

export function mountReplies(app: Hono, replies: ReplyService) {
  app.get('/reply-obligations', async (c) =>
    c.json({ obligations: (await replies.list()).map(obligationView) }),
  );
  app.post('/reply-obligations/:id/acknowledge', async (c) =>
    c.json(obligationView(await replies.acknowledge(c.req.param('id')))),
  );
  app.get('/notifications', async (c) =>
    c.json({ notifications: (await replies.outbox()).map(notificationView) }),
  );
  app.post('/notifications/:id/attempt', async (c) =>
    c.json(notificationView(await replies.beginDelivery(c.req.param('id')))),
  );
  app.post('/notifications/:id/delivered', async (c) => {
    const input = notificationDelivery.parse(await c.req.json());
    return c.json(notificationView(await replies.delivered(c.req.param('id'), input.content_hash)));
  });
}
