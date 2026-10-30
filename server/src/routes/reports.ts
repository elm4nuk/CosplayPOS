import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { idParam, parse } from '../lib/validation.ts';
import { eventSummary, exportCsv, exportQuery, summaryQuery } from '../services/reports.ts';

export async function registerReportRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/reports/events/:id/summary', { config: { admin: true } }, async (req) =>
    eventSummary(ctx, parse(idParam, req.params).id, parse(summaryQuery, req.query).top),
  );

  app.get('/api/reports/events/:id/export.csv', { config: { admin: true } }, async (req, reply) => {
    const { filename, body } = exportCsv(ctx, parse(idParam, req.params).id, parse(exportQuery, req.query));
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(body);
  });
}
