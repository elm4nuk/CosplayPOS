import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { AppError } from '../lib/errors.ts';
import { fileStamp } from '../lib/time.ts';
import { idParam, parse } from '../lib/validation.ts';
import { backupPath, createBackup, listBackups, restoreFromFile } from '../services/backup.ts';
import { getSettings, updateSettings, updateSettingsSchema } from '../services/settings.ts';
import { createUser, createUserSchema, listUsers, updateUser, updateUserSchema } from '../services/users.ts';

const backupNameParam = z.object({ name: z.string().max(100) });
const restoreJson = z.object({ name: z.string().max(100) });

export async function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // ---- User
  app.get('/api/users', { config: { admin: true } }, async () => ({ items: listUsers(ctx) }));

  app.post('/api/users', { config: { admin: true } }, async (req, reply) =>
    reply.status(201).send(await createUser(ctx, parse(createUserSchema, req.body))),
  );

  app.patch('/api/users/:id', { config: { admin: true } }, async (req) =>
    updateUser(ctx, parse(idParam, req.params).id, parse(updateUserSchema, req.body)),
  );

  // ---- Pengaturan
  app.get('/api/settings', async () => getSettings(ctx.store, ctx.config.timezone));

  app.patch('/api/settings', { config: { admin: true } }, async (req) => updateSettings(ctx, parse(updateSettingsSchema, req.body)));

  // ---- Backup & restore
  app.get('/api/admin/backups', { config: { admin: true } }, async () => ({
    items: listBackups(ctx),
    directory: ctx.config.backupDir,
    autoBackupMinutes: ctx.config.autoBackupMinutes,
  }));

  app.post('/api/admin/backups', { config: { admin: true } }, async (_req, reply) =>
    reply.status(201).send(createBackup(ctx, 'manual')),
  );

  app.get('/api/admin/backups/:name/download', { config: { admin: true } }, async (req, reply) => {
    const { name } = parse(backupNameParam, req.params);
    const file = backupPath(ctx, name);
    return reply
      .type('application/vnd.sqlite3')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('content-length', fs.statSync(file).size)
      .send(fs.createReadStream(file));
  });

  app.post('/api/admin/restore', { config: { admin: true } }, async (req) => {
    if (!req.isMultipart()) {
      const { name } = parse(restoreJson, req.body);
      return restoreFromFile(ctx, backupPath(ctx, name), name);
    }
    const file = await req.file();
    if (!file || file.fieldname !== 'file') throw new AppError('VALIDATION_ERROR', 'Field "file" wajib diisi');
    fs.mkdirSync(ctx.config.backupDir, { recursive: true });
    const tmp = path.join(ctx.config.backupDir, `upload-${fileStamp()}.tmp`);
    try {
      await pipeline(file.file, fs.createWriteStream(tmp));
      if (file.file.truncated) throw new AppError('PAYLOAD_TOO_LARGE', 'File backup terlalu besar');
      return restoreFromFile(ctx, tmp, file.filename || 'upload');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}
