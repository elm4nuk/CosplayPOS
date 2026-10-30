export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRICE_CHANGED'
  | 'EVENT_NOT_ACTIVE'
  | 'PRODUCT_UNAVAILABLE'
  | 'ANOTHER_EVENT_ACTIVE'
  | 'DUPLICATE'
  | 'STOCK_CHANGED'
  | 'NEGATIVE_STOCK'
  | 'ALREADY_VOIDED'
  | 'LAST_ADMIN'
  | 'INVALID_STATE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INSUFFICIENT_PAYMENT'
  | 'INVALID_BACKUP'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PRICE_CHANGED: 409,
  EVENT_NOT_ACTIVE: 409,
  PRODUCT_UNAVAILABLE: 409,
  ANOTHER_EVENT_ACTIVE: 409,
  DUPLICATE: 409,
  STOCK_CHANGED: 409,
  NEGATIVE_STOCK: 409,
  ALREADY_VOIDED: 409,
  LAST_ADMIN: 409,
  INVALID_STATE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INSUFFICIENT_PAYMENT: 422,
  INVALID_BACKUP: 422,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} tidak ditemukan`);

/** Ubah error UNIQUE constraint SQLite menjadi 409 DUPLICATE. */
export function rethrowUnique(err: unknown, field: string, message: string): never {
  if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
    throw new AppError('DUPLICATE', message, { field });
  }
  throw err;
}
