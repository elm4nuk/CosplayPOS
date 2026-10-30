/// <reference types="vite/client" />
import * as files from '../platform/files'
import { createLocalPosService } from './localPosService'

/**
 * The service the app should use. It stores everything on this phone (IndexedDB)
 * and works fully offline. `mockPosService` stays only for UI prototyping.
 */
export const posService = createLocalPosService({
  autoBackup: (backup) => files.writeRollingBackup(JSON.stringify(backup)),
  autoBackupEvery: 10,
})

// Device test hook (scripts/device-e2e.mjs). Only present in builds made with
// VITE_E2E=1; Vite removes this branch from normal builds.
if (import.meta.env.VITE_E2E === '1') Object.assign(window, { __cosplayPosE2E: { service: posService, files } })

export { PosError, isPosError } from '../storage/errors'
export { DEFAULT_LOW_STOCK_THRESHOLD } from './localPosService'
export type {
  BundlePricing, CashSession, CheckoutInput, CsvExport, EventComparisonReport, EventReport, LocalPosService, LowStockItem, PromoInvalidReason,
  ReadyState, SaveBundleInput, SaveProductInput, ShopSettings, StockCountInput, StockCountResult, TransactionFilter,
} from './localPosService'
export { IMAGE_LIMITS } from '../storage/images'
export type { PosErrorCode } from '../storage/errors'

