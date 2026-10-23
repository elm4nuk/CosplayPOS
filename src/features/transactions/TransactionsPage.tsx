import { useMemo, useState, type FormEvent } from 'react'
import { CircleAlert, Download, ReceiptText, Search, X } from 'lucide-react'
import type { LocalPosService } from '../../services'
import type { BootstrapData, Transaction } from '../../types'
import { filterTransactions, transactionsToCsv, type TransactionFilters } from './transactionUtils'

const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const formatRupiah = (value: number) => rupiah.format(value).replace('Rp', 'Rp ')
type Props = {
  data: BootstrapData
  service: LocalPosService
  refresh: () => Promise<void>
  receipt: (transaction: Transaction) => void
}

export function TransactionsPage({ data, service, refresh, receipt }: Props) {
  const [target, setTarget] = useState<Transaction | null>(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<TransactionFilters>({ query: '', date: '', eventId: '', method: 'all', status: 'all' })
  const filtered = useMemo(() => filterTransactions(data.transactions, filters), [data.transactions, filters])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!target) return
    try {
      await service.voidTransaction(target.id, String(new FormData(event.currentTarget).get('reason')))
      setTarget(null)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Transaksi tidak dapat dibatalkan.')
    }
  }

  const exportCsv = () => {
    const blob = new Blob([`\uFEFF${transactionsToCsv(filtered, data)}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `transaksi-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const reset = () => setFilters({ query: '', date: '', eventId: '', method: 'all', status: 'all' })

  return (
    <section className="admin-page">
      <div className="page-title">
        <div><p className="eyebrow">Jejak penjualan</p><h1>Riwayat transaksi</h1></div>
        <button type="button" className="button secondary" onClick={exportCsv} disabled={!filtered.length}><Download />Ekspor CSV</button>
      </div>
      {error && <div className="alert error" role="alert"><CircleAlert />{error}</div>}
      <div className="transaction-filters" aria-label="Filter transaksi">
        <label className="search-box"><Search /><span className="sr-only">Cari nomor struk</span><input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Cari nomor struk…" /></label>
        <label><span>Tanggal</span><input aria-label="Tanggal transaksi" type="date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })} /></label>
        <label><span>Event</span><select aria-label="Event transaksi" value={filters.eventId} onChange={(event) => setFilters({ ...filters, eventId: event.target.value })}><option value="">Semua event</option>{data.events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}</select></label>
        <label><span>Metode</span><select aria-label="Metode transaksi" value={filters.method} onChange={(event) => setFilters({ ...filters, method: event.target.value as TransactionFilters['method'] })}><option value="all">Semua metode</option><option value="cash">Tunai</option><option value="qris">QRIS</option></select></label>
        <label><span>Status</span><select aria-label="Status transaksi" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as TransactionFilters['status'] })}><option value="all">Semua status</option><option value="completed">Selesai</option><option value="void">Batal</option></select></label>
        <button type="button" className="button ghost small" onClick={reset}><X />Reset</button>
      </div>
      <p className="filter-result" role="status">Menampilkan {filtered.length} dari {data.transactions.length} transaksi</p>
      <div className="table-card">
        <table>
          <thead><tr><th>Nomor</th><th>Waktu</th><th>Event</th><th>Metode</th><th>Kasir</th><th>Total</th><th>Status</th><th>Aksi</th></tr></thead>
          <tbody>
            {!filtered.length ? <tr><td colSpan={8} className="empty-table-cell">Tidak ada transaksi yang cocok dengan filter.</td></tr> : filtered.map((transaction) => (
              <tr key={transaction.id}>
                <td><b>{transaction.number}</b>{transaction.voidReason && <small className="block void-reason">Alasan: {transaction.voidReason}</small>}</td>
                <td>{new Date(transaction.createdAt).toLocaleString('id-ID')}</td>
                <td>{data.events.find((event) => event.id === transaction.eventId)?.name ?? 'Event diarsipkan'}</td>
                <td><span className={`status-pill ${transaction.paymentMethod === 'qris' ? 'warning' : 'neutral'}`}>{transaction.paymentMethod === 'qris' ? 'QRIS' : 'Tunai'}</span></td>
                <td>{transaction.cashierName}</td>
                <td>{formatRupiah(transaction.total)}</td>
                <td><span className={`status-pill ${transaction.status === 'void' ? 'danger' : 'success'}`}>{transaction.status === 'void' ? 'Batal' : 'Selesai'}</span></td>
                <td><div className="action-row"><button className="button ghost small" onClick={() => receipt(transaction)}><ReceiptText />Struk</button>{transaction.status !== 'void' && <button className="button danger small" onClick={() => setTarget(transaction)}>Batalkan</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {target && (
        <div className="modal-layer">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="void-title">
            <div className="modal-head"><h2 id="void-title">Batalkan {target.number}?</h2><button className="icon-button" onClick={() => setTarget(null)} aria-label="Tutup"><X /></button></div>
            <form className="stack-form" onSubmit={submit}>
              <div className="confirm-impact"><CircleAlert /><div><b>Transaksi akan dibatalkan</b><p>Stok seluruh item dikembalikan. Transaksi tetap ada di riwayat dan tidak dihitung sebagai omzet.</p></div></div>
              <label>Alasan pembatalan<input name="reason" autoFocus required minLength={3} placeholder="Contoh: salah pilih varian" /></label>
              <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setTarget(null)}>Batal</button><button className="button danger grow" type="submit">Konfirmasi</button></div>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}
