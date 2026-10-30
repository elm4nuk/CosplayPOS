import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, SESSION_COOKIE } from '../app.ts';
import type { Ctx } from '../context.ts';
import { parse } from '../lib/validation.ts';
import { changePassword, login, logout, type LoginLimiter } from '../services/auth.ts';
import { getUser, passwordSchema } from '../services/users.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username wajib diisi').max(64),
  password: z.string().min(1, 'Password wajib diisi').max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export async function registerAuthRoutes(app: FastifyInstance, ctx: Ctx, limiter: LoginLimiter): Promise<void> {
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const result = await login(ctx, limiter, body, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    reply.setCookie(SESSION_COOKIE, result.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // LAN memakai http biasa
      expires: new Date(result.expiresAt),
    });
    return result;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const auth = requireAuth(req);
    logout(ctx, auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const auth = requireAuth(req);
    return { user: getUser(ctx.store, auth.user.id), expiresAt: auth.expiresAt };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const auth = requireAuth(req);
    await changePassword(ctx, auth, parse(changePasswordSchema, req.body));
    return reply.status(204).send();
  });
}
