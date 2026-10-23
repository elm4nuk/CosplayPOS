import { describe, expect, it } from 'vitest'
import { filterTransactions, transactionsToCsv } from './transactionUtils'
import type { Transaction } from '../../types'

const transactions: Transaction[] = [
  {
    id: 'tx-cash', number: 'TRX-0001', eventId: 'event-a', createdAt: '2026-10-22T10:00:00.000Z', cashierName: 'Nami', items: [],
    total: 25000, cashReceived: 50000, change: 25000, paymentMethod: 'cash', status: 'completed',
  },
  {
    id: 'tx-qris', number: 'TRX-0002', eventId: 'event-b', createdAt: '2026-10-23T11:00:00.000Z', cashierName: 'Nami', items: [],
    total: 40000, cashReceived: 40000, change: 0, paymentMethod: 'qris', status: 'void', voidReason: 'Pesanan ganda',
  },
]

describe('filter dan ekspor transaksi', () => {
  it('memfilter nomor struk, tanggal, event, metode, dan status secara bersamaan', () => {
    expect(filterTransactions(transactions, {
      query: '0002', date: '2026-10-23', eventId: 'event-b', method: 'qris', status: 'void',
    })).toEqual([transactions[1]])
    expect(filterTransactions(transactions, {
      query: '0002', date: '2026-10-22', eventId: 'event-b', method: 'qris', status: 'void',
    })).toEqual([])
  })

  it('menghasilkan CSV dengan header, event, metode, status, dan escape nilai', () => {
    const csv = transactionsToCsv(transactions, { events: [
      { id: 'event-a', name: 'Comifuro, Day 1', venue: '', dateLabel: '', active: true },
      { id: 'event-b', name: 'ChibiCon', venue: '', dateLabel: '', active: false },
    ] })
    expect(csv).toContain('"Nomor struk","Tanggal","Event","Metode"')
    expect(csv).toContain('"Comifuro, Day 1"')
    expect(csv).toContain('"QRIS"')
    expect(csv).toContain('"Batal","Pesanan ganda"')
  })
})
