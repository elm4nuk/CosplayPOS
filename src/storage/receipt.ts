import type { Transaction } from '../types'

export type ReceiptSettings = { shopName: string; footer: string }

/** 58 mm thermal paper fits 32 monospace columns. */
export const RECEIPT_COLUMNS = 32

const num = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })
const money = (value: number) => num.format(value)

const center = (text: string, width: number) => {
  const cut = text.slice(0, width)
  return ' '.repeat(Math.floor((width - cut.length) / 2)) + cut
}

const row = (left: string, right: string, width: number) => {
  const room = width - right.length - 1
  const cut = left.length > room ? left.slice(0, Math.max(0, room - 1)) + '…' : left
  return cut + ' '.repeat(Math.max(1, width - cut.length - right.length)) + right
}

const wrap = (text: string, width: number) => {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}

/**
 * Plain-text receipt for viewing, sharing as .txt, and later ESC/POS printing.
 * Kept free of DOM/Capacitor so it can be reused by a printer driver.
 */
export function formatReceiptText(tx: Transaction, settings: ReceiptSettings, width = RECEIPT_COLUMNS) {
  const rule = '-'.repeat(width)
  const when = new Date(tx.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
  const lines = [
    center(settings.shopName, width),
    rule,
    row('No', tx.number, width),
    row('Waktu', when, width),
    row('Kasir', tx.cashierName, width),
    rule,
  ]
  for (const item of tx.items) {
    const hasVariant = item.variantName && item.variantName !== 'Default' && item.variantName !== item.productName
    lines.push(...wrap(hasVariant ? `${item.productName} (${item.variantName})` : item.productName, width))
    lines.push(row(`  ${item.quantity} x ${money(item.price)}`, money(item.price * item.quantity), width))
  }
  if (tx.discount && tx.discount > 0) {
    const subtotal = tx.subtotal ?? (tx.total + tx.discount)
    lines.push(rule)
    lines.push(row('Subtotal', `Rp ${money(subtotal)}`, width))
    const promoLabel = tx.promoName ? `Diskon (${tx.promoName})` : 'Diskon Bundle'
    lines.push(row(promoLabel, `-Rp ${money(tx.discount)}`, width))
  }
  lines.push(rule, row('TOTAL', `Rp ${money(tx.total)}`, width))
  if (tx.paymentMethod === 'qris') {
    lines.push(row('Metode', 'QRIS (Lunas)', width))
  } else {
    lines.push(row('Tunai', `Rp ${money(tx.cashReceived)}`, width), row('Kembali', `Rp ${money(tx.change)}`, width))
  }
  if (tx.status === 'void') lines.push(rule, center('*** DIBATALKAN ***', width))
  if (settings.footer) lines.push(rule, ...settings.footer.split('\n').flatMap((line) => wrap(line, width).map((part) => center(part, width))))
  return lines.join('\n') + '\n'
}
