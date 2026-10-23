import type { BootstrapData, Transaction } from '../../types'

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`

export type TransactionFilters = {
  query: string
  date: string
  eventId: string
  method: 'all' | 'cash' | 'qris'
  status: 'all' | 'completed' | 'void'
}

export function filterTransactions(transactions: Transaction[], filters: TransactionFilters) {
  const query = filters.query.trim().toLowerCase()
  return transactions.filter((transaction) => {
    const transactionDate = transaction.createdAt.slice(0, 10)
    return (!query || transaction.number.toLowerCase().includes(query))
      && (!filters.date || transactionDate === filters.date)
      && (!filters.eventId || transaction.eventId === filters.eventId)
      && (filters.method === 'all' || (transaction.paymentMethod ?? 'cash') === filters.method)
      && (filters.status === 'all' || transaction.status === filters.status)
  })
}

export function transactionsToCsv(transactions: Transaction[], data: Pick<BootstrapData, 'events'>) {
  const rows = transactions.map((transaction) => [
    transaction.number,
    transaction.createdAt,
    data.events.find((event) => event.id === transaction.eventId)?.name ?? 'Event tidak ditemukan',
    transaction.paymentMethod === 'qris' ? 'QRIS' : 'Tunai',
    transaction.cashierName,
    transaction.total,
    transaction.status === 'void' ? 'Batal' : 'Selesai',
    transaction.voidReason ?? '',
  ])
  return [['Nomor struk', 'Tanggal', 'Event', 'Metode', 'Kasir', 'Total', 'Status', 'Alasan batal'], ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
}
