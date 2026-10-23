export type CsvCell = string | number | null | undefined

/**
 * RFC 4180 CSV with CRLF line endings and a UTF-8 BOM so Excel on Windows/Android
 * shows "Rp"/accented names correctly. Text starting with = + - @ (or tab/CR) is
 * prefixed with `'` so a product or event name can never run as a spreadsheet
 * formula. Numbers are written as plain integers (rupiah, no separators).
 */
export function toCsv(rows: CsvCell[][]) {
  return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

function cell(value: CsvCell) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Device-local `YYYY-MM-DD HH:mm`, the format spreadsheets parse as a date. */
export const localDateTime = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const csvFileName = (prefix: string, date: Date) => `${prefix}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.csv`
