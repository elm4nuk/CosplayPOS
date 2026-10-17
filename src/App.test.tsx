import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App'
import { createLocalPosService, type LocalPosService } from './services/localPosService'
import { seedDemoCatalog } from './testing/demoCatalog'

Object.defineProperty(window, 'scrollTo', { value: () => undefined, writable: true })

let service: LocalPosService | null = null
const makeService = () => (service = createLocalPosService({ dbName: `ui-${crypto.randomUUID()}` }))
const prepared = async (withDemo = true) => {
  const next = makeService()
  await next.ready()
  await next.saveSettings({ defaultCashier: 'Kasir Demo', shopName: 'Booth Bintang' })
  if (withDemo) await seedDemoCatalog(next)
  return next
}
const openTill = async (next: LocalPosService) => {
  render(<App service={next} />)
  await screen.findByRole('heading', { name: /pilih dagangan/i })
}

afterEach(async () => {
  if (service) { service.close(); await service.db.delete(); service = null }
})

describe('alur UI produksi offline tanpa autentikasi', () => {
  it('langsung membuka kasir tanpa login, password, atau onboarding PIN', async () => {
    await openTill(await prepared(false))
    expect(screen.queryByLabelText(/pin|kata sandi|password/i)).not.toBeInTheDocument()
    expect(screen.getByText(/belum ada produk/i)).toBeInTheDocument()
  })

  it('checkout memakai data lokal dan stok habis tidak bisa dijual lagi', async () => {
    const next = await prepared(false); const data = await next.getBootstrap(); const category = await next.saveCategory({ name: 'Print' })
    await next.saveProduct({ name: 'Print stok satu', categoryId: category.id, variants: [{ name: 'A5', price: 15000, stock: 1 }] })
    await openTill(next); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /tambah print stok satu/i })); await user.click(screen.getByRole('button', { name: /bayar sekarang/i })); await user.click(screen.getByRole('button', { name: /uang pas/i })); await user.click(screen.getByRole('button', { name: /simpan pembayaran/i }))
    expect(await screen.findByRole('dialog', { name: /transaksi berhasil/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /transaksi baru/i }))
    expect(screen.getByRole('button', { name: /tambah print stok satu/i })).toBeDisabled()
    expect((await next.getBootstrap()).events[0].id).toBe(data.events[0].id)
  })

  it('menolak uang kurang dan menghitung kembalian dari nominal cepat', async () => {
    const next = await prepared(); await openTill(next); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /tambah bundle booth bestie/i })); await user.click(screen.getByRole('button', { name: /bayar sekarang/i }))
    const money = screen.getByLabelText(/uang diterima/i); await user.type(money, '10000')
    expect(screen.getByRole('button', { name: /simpan pembayaran/i })).toBeDisabled()
    await user.clear(money); await user.click(screen.getByRole('button', { name: 'Rp 100.000' }))
    expect(screen.getByText('Rp 25.000', { selector: '.change-box strong' })).toBeInTheDocument()
  })

  it('meminta alasan dan menjelaskan dampak sebelum membatalkan transaksi', async () => {
    const next = await prepared(); const data = await next.getBootstrap(); const product = data.products.find((candidate) => candidate.variants.some((variant) => variant.stock > 0))!; const variant = product.variants.find((x) => x.stock > 0)!
    await next.createTransaction({ eventId: data.events[0].id, items: [{ productId: product.id, variantId: variant.id, quantity: 1 }], cashReceived: variant.price, idempotencyKey: crypto.randomUUID() })
    await openTill(next); const user = userEvent.setup(); await user.click(screen.getAllByRole('button', { name: /^transaksi$/i })[0]); await user.click(await screen.findByRole('button', { name: /batalkan/i }))
    expect(screen.getByText(/stok seluruh item dikembalikan/i)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: /^konfirmasi$/i }); expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect((await next.getBootstrap()).transactions[0].status).toBe('completed')
    await user.type(screen.getByLabelText(/alasan pembatalan/i), 'Salah pilih varian'); await user.click(confirm)
    await waitFor(async () => expect((await next.getBootstrap()).transactions[0]).toMatchObject({ status: 'void', voidReason: 'Salah pilih varian' }))
  })

  it('menampilkan transaksi tersimpan lagi saat aplikasi dirender ulang', async () => {
    const next = await prepared(); const data = await next.getBootstrap(); const product = data.products[0]; const variant = product.variants.find((x) => x.stock > 0)!
    await next.createTransaction({ eventId: data.events[0].id, items: [{ productId: product.id, variantId: variant.id, quantity: 1 }], cashReceived: variant.price, idempotencyKey: crypto.randomUUID() })
    await openTill(next); const user = userEvent.setup(); await user.click(screen.getAllByRole('button', { name: /^transaksi$/i })[0])
    await waitFor(() => expect(screen.getByText(/TRX-|CCF-/)).toBeInTheDocument())
  })

  it('tambah produk memiliki upload foto dan tidak ada input varian', async () => {
    const next = await prepared(false)
    await next.saveCategory({ name: 'Merchandise' })
    await openTill(next)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /produk baru/i }))
    expect(await screen.findByRole('heading', { name: /produk baru/i })).toBeInTheDocument()

    expect(screen.queryByLabelText(/varian/i)).not.toBeInTheDocument()
    expect(screen.getByText(/unggah foto produk/i)).toBeInTheDocument()

    await user.type(screen.getByLabelText(/nama produk/i), 'Stiker Hologram')
    await user.type(screen.getByLabelText(/deskripsi/i), 'Stiker vinyl tahan air')
    await user.type(screen.getByLabelText(/harga/i), '12000')
    await user.type(screen.getByLabelText(/stok awal/i), '25')

    await user.click(screen.getByRole('button', { name: /^simpan$/i }))

    await waitFor(() => expect(screen.getByText('Stiker Hologram')).toBeInTheDocument())
    expect(screen.getByText('Rp 12.000')).toBeInTheDocument()
    expect(screen.getByText('25')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /^kasir$/i })[0])
    expect(await screen.findByRole('heading', { name: /pilih dagangan/i })).toBeInTheDocument()
    expect(screen.getByText('Stiker Hologram')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tambah stiker hologram/i })).toBeInTheDocument()
  })

  it('dapat menghapus produk dan menghilangkannya dari daftar serta kasir', async () => {
    const next = await prepared(false)
    const category = await next.saveCategory({ name: 'Prints' })
    await next.saveProduct({ name: 'Poster Keren', categoryId: category.id, price: 50000, stock: 5 })
    await openTill(next)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()
    expect(screen.getByText('Poster Keren')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hapus poster keren/i }))
    expect(await screen.findByRole('dialog', { name: /hapus produk poster keren\?/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^hapus produk$/i }))

    await waitFor(() => expect(screen.queryByText('Poster Keren')).not.toBeInTheDocument())
  })
})
