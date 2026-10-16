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
