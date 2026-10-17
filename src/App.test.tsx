import 'fake-indexeddb/auto'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  it('dapat memfilter produk berdasarkan kategori yang diklik pada menu Produk', async () => {
    const next = await prepared(false)
    const catPrint = await next.saveCategory({ name: 'Prints' })
    const catCharm = await next.saveCategory({ name: 'Charms' })
    await next.saveProduct({ name: 'Poster Rem', categoryId: catPrint.id, price: 25000, stock: 10 })
    await next.saveProduct({ name: 'Keychain Emilia', categoryId: catCharm.id, price: 35000, stock: 8 })
    await openTill(next)
    const user = userEvent.setup()

    // Buka menu Produk
    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()

    // Awalnya kedua produk muncul
    expect(screen.getByText('Poster Rem')).toBeInTheDocument()
    expect(screen.getByText('Keychain Emilia')).toBeInTheDocument()

    // Klik filter kategori "Charms"
    const charmsFilter = screen.getByRole('tab', { name: /charms/i })
    await user.click(charmsFilter)

    // Hanya produk Charms yang muncul, Poster Rem disembunyikan
    expect(screen.getByText('Keychain Emilia')).toBeInTheDocument()
    expect(screen.queryByText('Poster Rem')).not.toBeInTheDocument()

    // Klik tombol Reset filter
    await user.click(screen.getByRole('button', { name: /reset filter/i }))
    expect(screen.getByText('Poster Rem')).toBeInTheDocument()
    expect(screen.getByText('Keychain Emilia')).toBeInTheDocument()

    // Klik tombol kategori langsung di kolom tabel (pada baris Poster Rem)
    const printLink = screen.getByRole('button', { name: /filter kategori prints/i })
    await user.click(printLink)

    // Sekarang hanya Poster Rem yang muncul
    expect(screen.getByText('Poster Rem')).toBeInTheDocument()
    expect(screen.queryByText('Keychain Emilia')).not.toBeInTheDocument()
  })

  it('dapat memfilter dagangan berdasarkan kategori yang diklik pada kasir', async () => {
    const next = await prepared(false)
    const catPrint = await next.saveCategory({ name: 'Postcard' })
    const catPin = await next.saveCategory({ name: 'Pins' })
    await next.saveProduct({ name: 'Postcard Summer', categoryId: catPrint.id, price: 10000, stock: 15 })
    await next.saveProduct({ name: 'Pin Metal Star', categoryId: catPin.id, price: 20000, stock: 5 })
    await openTill(next)
    const user = userEvent.setup()

    // Kedua produk muncul di kasir
    expect(screen.getByText('Postcard Summer')).toBeInTheDocument()
    expect(screen.getByText('Pin Metal Star')).toBeInTheDocument()

    // Klik kategori "Pins" di bar kasir
    await user.click(screen.getByRole('tab', { name: /pins/i }))

    // Hanya Pin Metal Star yang muncul
    expect(screen.getByText('Pin Metal Star')).toBeInTheDocument()
    expect(screen.queryByText('Postcard Summer')).not.toBeInTheDocument()

    // Klik kategori "Semua"
    await user.click(screen.getByRole('tab', { name: /semua/i }))
    expect(screen.getByText('Postcard Summer')).toBeInTheDocument()
    expect(screen.getByText('Pin Metal Star')).toBeInTheDocument()
  })

  it('dapat memfilter varian inventori berdasarkan kategori yang diklik pada menu Stok', async () => {
    const next = await prepared(false)
    const catBook = await next.saveCategory({ name: 'Buku' })
    const catSticker = await next.saveCategory({ name: 'Stiker' })
    await next.saveProduct({ name: 'Manga Vol 1', categoryId: catBook.id, price: 40000, stock: 6 })
    await next.saveProduct({ name: 'Sticker Pack Chibi', categoryId: catSticker.id, price: 15000, stock: 20 })
    await openTill(next)
    const user = userEvent.setup()

    // Buka menu Stok
    await user.click(screen.getAllByRole('button', { name: /^stok$/i })[0])
    expect(await screen.findByRole('heading', { name: /stok booth/i })).toBeInTheDocument()

    // Keduanya ada di tabel stok
    expect(screen.getByRole('cell', { name: /manga vol 1/i })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: /sticker pack chibi/i })).toBeInTheDocument()

    // Klik filter kategori "Buku"
    await user.click(screen.getByRole('tab', { name: /buku/i }))

    // Hanya Manga Vol 1 yang tampil di tabel stok
    expect(screen.getByRole('cell', { name: /manga vol 1/i })).toBeInTheDocument()
    expect(screen.queryByRole('cell', { name: /sticker pack chibi/i })).not.toBeInTheDocument()
  })

  it('dapat menambah promo bundle di kasir, menghitung diskon dan mencantumkannya di struk', async () => {
    const next = await prepared(false)
    const cat = await next.saveCategory({ name: 'Merch' })
    const p1 = await next.saveProduct({ name: 'Gantungan Akrilik', categoryId: cat.id, price: 30000, stock: 10 })
    const p2 = await next.saveProduct({ name: 'Art Print A5', categoryId: cat.id, price: 25000, stock: 10 })
    await next.saveBundle({
      name: 'Bundle Hemat Wibu',
      price: 45000,
      items: [
        { productId: p1.id, variantId: p1.variants[0].id, quantity: 1 },
        { productId: p2.id, variantId: p2.variants[0].id, quantity: 1 },
      ],
      active: true,
    })
    await openTill(next)
    const user = userEvent.setup()

    expect(screen.getByText('Bundle Hemat Wibu')).toBeInTheDocument()
    expect(screen.getByText('Hemat Rp 10.000')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /tambah bundle hemat wibu/i }))

    expect(screen.getByText('Bundle Hemat Wibu', { selector: '.cart-promo-info b' })).toBeInTheDocument()
    expect(screen.getByText('Hemat Rp 10.000', { selector: '.cart-promo-info small' })).toBeInTheDocument()
    expect(screen.getByText('-Rp 10.000', { selector: '.discount-row span:last-child' })).toBeInTheDocument()
    expect(screen.getByText('Rp 45.000', { selector: '.grand-total strong' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /bayar sekarang/i }))
    const checkoutModal = screen.getByRole('dialog', { name: /pembayaran/i })
    expect(within(checkoutModal).getByText(/diskon rp 10\.000/i)).toBeInTheDocument()
    expect(within(checkoutModal).getByText('Rp 45.000', { selector: '.checkout-total strong' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /uang pas/i }))
    await user.click(screen.getByRole('button', { name: /simpan pembayaran/i }))

    expect(await screen.findByRole('dialog', { name: /transaksi berhasil/i })).toBeInTheDocument()
    expect(screen.getByText(/subtotal/i)).toBeInTheDocument()
    expect(screen.getByText(/-Rp 10\.000/i)).toBeInTheDocument()
    expect(screen.getAllByText('Rp 45.000', { selector: '.receipt-totals b' }).length).toBeGreaterThanOrEqual(1)
  })

  it('dapat berpindah ke tab Promo Bundle di menu Produk dan membuat bundle baru', async () => {
    const next = await prepared(false)
    const cat = await next.saveCategory({ name: 'Pin' })
    await next.saveProduct({ name: 'Badge Pin A', categoryId: cat.id, price: 15000, stock: 5 })
    await openTill(next)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /^produk$/i })[0])
    expect(await screen.findByRole('heading', { name: /produk & kategori/i })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /promo bundle/i }))
    expect(screen.getByText(/belum ada promo bundle/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /buat promo bundle/i }))
    expect(await screen.findByRole('dialog', { name: /promo bundle baru/i })).toBeInTheDocument()

    await user.type(screen.getByLabelText(/nama promo bundle/i), 'Bundle Pin Kembar')
    await user.type(screen.getByLabelText(/harga spesial bundle/i), '25000')
    await user.click(screen.getByRole('button', { name: /simpan promo bundle/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /promo bundle baru/i })).not.toBeInTheDocument()
    })
    expect(screen.getByText('Bundle Pin Kembar')).toBeInTheDocument()
    expect(screen.getByText('Rp 25.000', { selector: '.bundle-price-big' })).toBeInTheDocument()
  })

  it('dapat melihat laporan perbandingan antar event', async () => {
    const next = await prepared(false)
    const data = await next.getBootstrap()
    const ev1 = data.events[0]
    const ev2 = await next.saveEvent({ name: 'Comic Frontier 20', dateLabel: '10 Nov 2026', venue: 'ICE BSD' })
    const cat = await next.saveCategory({ name: 'Prints' })
    const prod = await next.saveProduct({ name: 'Art Print Rem', categoryId: cat.id, price: 50000, stock: 100 })

    await next.createTransaction({
      eventId: ev1.id,
      items: [{ productId: prod.id, variantId: prod.variants[0].id, quantity: 2 }],
      cashReceived: 100000,
      paymentMethod: 'cash',
      idempotencyKey: crypto.randomUUID(),
    })
    await next.createTransaction({
      eventId: ev2.id,
      items: [{ productId: prod.id, variantId: prod.variants[0].id, quantity: 3 }],
      cashReceived: 150000,
      paymentMethod: 'qris',
      idempotencyKey: crypto.randomUUID(),
    })

    await openTill(next)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /^laporan$/i })[0])
    expect(await screen.findByRole('heading', { name: /laporan/i })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /perbandingan antar event/i }))

    expect(await screen.findByText(/event terlaris \(omzet\)/i)).toBeInTheDocument()
    expect(screen.getAllByText('Comic Frontier 20').length).toBeGreaterThan(0)
    expect(screen.getByText('Perbandingan Omzet Antar Event')).toBeInTheDocument()
    expect(screen.getByText('Produk Terlaris Lintas Event')).toBeInTheDocument()
    expect(screen.getByText('Tabel Evaluasi Komparasi Seluruh Event')).toBeInTheDocument()
  })
})

