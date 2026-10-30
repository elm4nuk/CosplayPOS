import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../app.ts';
import type { Ctx } from '../context.ts';
import { parse } from '../lib/validation.ts';
import { getReceipt, receiptHtml } from '../services/receipt.ts';
import {
  checkout,
  checkoutSchema,
  getTransaction,
  listTransactions,
  listTransactionsQuery,
  voidSchema,
  voidTransaction,
} from '../services/transactions.ts';

const refParam = z.object({ ref: z.string().trim().min(1).max(40) });
const receiptHtmlQuery = z.object({
  width: z.enum(['58', '80']).default('58'),
  print: z.enum(['0', '1', 'true', 'false']).optional(),
});

export async function registerTransactionRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.post('/api/transactions', async (req, reply) => {
    const auth = requireAuth(req);
    const result = checkout(ctx, auth.user, parse(checkoutSchema, req.body));
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/transactions', async (req) => listTransactions(ctx, parse(listTransactionsQuery, req.query)));

  app.get('/api/transactions/:ref', async (req) => getTransaction(ctx.store, parse(refParam, req.params).ref));

  app.post('/api/transactions/:ref/void', { config: { admin: true } }, async (req) => {
    const auth = requireAuth(req);
    const { reason } = parse(voidSchema, req.body);
    return voidTransaction(ctx, auth.user, parse(refParam, req.params).ref, reason);
  });

  app.get('/api/transactions/:ref/receipt', async (req) => getReceipt(ctx, parse(refParam, req.params).ref));

  app.get('/api/transactions/:ref/receipt.html', async (req, reply) => {
    const q = parse(receiptHtmlQuery, req.query);
    const html = receiptHtml(getReceipt(ctx, parse(refParam, req.params).ref), {
      widthMm: q.width === '80' ? 80 : 58,
      autoPrint: q.print === '1' || q.print === 'true',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
