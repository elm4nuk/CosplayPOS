import type { Config } from './config.ts';
import type { Store } from './db/store.ts';
import type { EventBus } from './lib/bus.ts';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Ctx {
  config: Config;
  store: Store;
  bus: EventBus;
  log: Logger;
}

export type Role = 'admin' | 'cashier';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export interface AuthInfo {
  user: AuthUser;
  sessionId: number;
  expiresAt: string;
}
