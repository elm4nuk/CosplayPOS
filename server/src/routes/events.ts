import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { idParam, parse } from '../lib/validation.ts';
import {
  createEvent,
  createEventSchema,
  getActiveEvent,
  getEvent,
  listEvents,
  updateEvent,
  updateEventSchema,
} from '../services/events.ts';

export async function registerEventRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/events', async () => ({ items: listEvents(ctx) }));

  app.get('/api/events/active', async () => ({ event: getActiveEvent(ctx.store) }));

  app.get('/api/events/:id', async (req) => getEvent(ctx.store, parse(idParam, req.params).id));

  app.post('/api/events', { config: { admin: true } }, async (req, reply) => {
    const event = createEvent(ctx, parse(createEventSchema, req.body));
    return reply.status(201).send(event);
  });

  app.patch('/api/events/:id', { config: { admin: true } }, async (req) =>
    updateEvent(ctx, parse(idParam, req.params).id, parse(updateEventSchema, req.body)),
  );
}
