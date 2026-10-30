export type PosErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'EMPTY_CART'
  | 'INSUFFICIENT_CASH'
  | 'STOCK_CHANGED'
  | 'EVENT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_VOID'
  | 'BACKUP_INVALID'
  /** Event exists but is archived: readable in reports, not usable for new sales. */
  | 'EVENT_ARCHIVED'
  /** Archiving the active event needs `replacementEventId`. */
  | 'EVENT_REPLACEMENT_REQUIRED'
  /** Bundle cannot be applied; `details.reason` is a `PromoInvalidReason`. */
  | 'PROMO_INVALID'
  /** QRIS checkout without the cashier's explicit `paymentConfirmed: true`. */
  | 'PAYMENT_NOT_CONFIRMED'
  | 'IMAGE_INVALID_TYPE'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSIONS'
  | 'IMAGE_DECODE_FAILED'
  | 'CASH_SESSION_OPEN'
  | 'CASH_SESSION_NOT_OPEN'

/** Errors the UI can branch on via `code`; `message` is ready to show (id-ID). */
export class PosError extends Error {
  readonly code: PosErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: PosErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PosError'
    this.code = code
    this.details = details
  }
}

export const isPosError = (value: unknown, code?: PosErrorCode): value is PosError =>
  value instanceof PosError && (code === undefined || value.code === code)
