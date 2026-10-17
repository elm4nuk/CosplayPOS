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

  it('menampilkan indikator stok menipis pada kartu kasir dan tabel produk', async () => {
    const next = await prepared(false)
    const category = await next.saveCategory({ name: 'Keychains' })
    await next.saveProduct({ name: 'Gantungan Kunci Fox', categoryId: category.id, price: 20000, stock: 2 })
    await openTill(next)

    // Di kasir, produk dengan stok 2 harus menampilkan indikator stok menipis
    expect(screen.getAllByText(/sisa 2/i).length).toBeGreaterThanOrEqual(1)

    // Buka menu produk
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()
    expect(screen.getAllByText(/sisa 2/i).length).toBeGreaterThanOrEqual(1)
  })

  it('dapat mengedit produk (nama, harga, stok) dan perubahan tampil di katalog', async () => {
    const next = await prepared(false)
    const category = await next.saveCategory({ name: 'Badge' })
    await next.saveProduct({ name: 'Pin Button A', categoryId: category.id, price: 10000, stock: 5 })
    await openTill(next)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()
    expect(screen.getByText('Pin Button A')).toBeInTheDocument()

    // Klik tombol Edit
    await user.click(screen.getByRole('button', { name: /edit pin button a/i }))
    expect(await screen.findByRole('heading', { name: /edit pin button a/i })).toBeInTheDocument()

    // Ubah nama, harga, stok
    const nameInput = screen.getByLabelText(/nama produk/i)
    await user.clear(nameInput)
    await user.type(nameInput, 'Pin Button A Special Edition')

    const priceInput = screen.getByLabelText(/harga/i)
    await user.clear(priceInput)
    await user.type(priceInput, '15000')

    const stockInput = screen.getByLabelText(/jumlah stok/i)
    await user.clear(stockInput)
    await user.type(stockInput, '12')

    await user.click(screen.getByRole('button', { name: /^simpan$/i }))

    await waitFor(() => expect(screen.getByText('Pin Button A Special Edition')).toBeInTheDocument())
    expect(screen.getByText('Rp 15.000')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('dapat checkout menggunakan metode QRIS dan struk mencantumkan QRIS', async () => {
    const next = await prepared(false)
    const category = await next.saveCategory({ name: 'Art' })
    await next.saveProduct({ name: 'Artbook Vol 1', categoryId: category.id, price: 75000, stock: 4 })
    await openTill(next)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /tambah artbook vol 1/i }))
    await user.click(screen.getByRole('button', { name: /bayar sekarang/i }))

    // Pilih tab QRIS
    await user.click(screen.getByRole('tab', { name: /qris/i }))
    expect(screen.getByRole('button', { name: /konfirmasi pembayaran qris/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /konfirmasi pembayaran qris/i }))
    expect(await screen.findByRole('dialog', { name: /transaksi berhasil/i })).toBeInTheDocument()
    expect(screen.getByText(/qris \(lunas\)/i)).toBeInTheDocument()
  })
})
