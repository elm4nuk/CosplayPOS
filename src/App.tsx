import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Archive, BadgeCheck, BarChart3, CalendarDays, Check, ChevronDown, CircleAlert,
  CircleDollarSign, Download, FileUp, History, ImagePlus, LayoutGrid,
  Minus, Package, Plus, ReceiptText, Search, Settings, Share2,
  ShoppingBag, Sparkles, Tag, Trash2, Upload, WifiOff, X,
} from 'lucide-react'
import { backupFileName, saveToDevice, shareFile } from './platform/files'
import { optimizeImageFile } from './platform/images'
import { isPosError, posService, type EventReport, type LocalPosService, type ShopSettings } from './services'
import type { BoothEvent, BootstrapData, CartItem, Product, Transaction } from './types'

type Screen = 'pos' | 'products' | 'stock' | 'events' | 'reports' | 'transactions' | 'settings'
const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const formatRupiah = (value: number) => rupiah.format(value).replace('Rp', 'Rp ')
const formatCashInput = (value: number) => value ? new Intl.NumberFormat('id-ID').format(value) : ''
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : 'Terjadi kesalahan. Coba lagi.'
const NAV: { id: Screen; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'pos', label: 'Kasir', icon: LayoutGrid }, { id: 'products', label: 'Produk', icon: Tag },
  { id: 'stock', label: 'Stok', icon: Archive }, { id: 'events', label: 'Event', icon: CalendarDays },
  { id: 'reports', label: 'Laporan', icon: BarChart3 }, { id: 'transactions', label: 'Transaksi', icon: History },
  { id: 'settings', label: 'Pengaturan', icon: Settings },
]
const quickCash = (total: number) => [...new Set([total, ...[10000, 20000, 50000, 100000].map((n) => Math.ceil(total / n) * n), 50000, 100000, 200000, 500000])].filter((n) => n >= total).sort((a, b) => a - b).slice(0, 4)

function BrandMark({ small = false }: { small?: boolean }) { return <span className={`brand-mark ${small ? 'brand-mark--small' : ''}`} aria-hidden="true"><Sparkles size={small ? 18 : 24} strokeWidth={2.5} /></span> }
function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'success' }) { return <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{tone === 'error' ? <CircleAlert size={20} /> : <Check size={20} />}{children}</div> }
function Sidebar({ screen, setScreen, cashierName, shopName }: { screen: Screen; setScreen: (s: Screen) => void; cashierName: string; shopName: string }) {
  return <aside className="sidebar"><div className="brand-lockup sidebar-brand"><BrandMark /><span>{shopName}</span></div><nav aria-label="Navigasi utama">{NAV.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setScreen(id)} className={screen === id ? 'active' : ''} aria-current={screen === id ? 'page' : undefined}><Icon size={21} /><span>{label}</span></button>)}</nav><div className="sidebar-user sidebar-user--static"><span className="avatar">{cashierName[0]?.toUpperCase()}</span><span><b>{cashierName}</b><small>Kasir booth · siap offline</small></span></div></aside>
}
function MobileNav({ screen, setScreen, cartCount, openCart }: { screen: Screen; setScreen: (s: Screen) => void; cartCount: number; openCart: () => void }) { const compact = NAV.slice(0, 3); return <nav className="mobile-nav" aria-label="Navigasi seluler">{compact.map(({ id, label, icon: Icon }) => <button key={id} className={screen === id ? 'active' : ''} onClick={() => setScreen(id)}><Icon size={21} /><span>{label}</span></button>)}<button onClick={openCart}><ShoppingBag size={21} /><span>Keranjang</span>{cartCount > 0 && <b>{cartCount}</b>}</button><button onClick={() => setScreen('settings')} className={!compact.some((x) => x.id === screen) && screen !== 'pos' ? 'active' : ''}><Settings size={21} /><span>Lainnya</span></button></nav> }
function AppHeader({ event, events, change }: { event?: BoothEvent; events: BoothEvent[]; change: (id: string) => void }) { return <header className="app-header"><div><p className="eyebrow">Event aktif</p><label className="event-picker"><span className="sr-only">Pilih event aktif</span><select value={event?.id ?? ''} onChange={(e) => change(e.target.value)}>{events.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select><ChevronDown size={18} /></label><p className="event-meta">{event?.venue || 'Lokasi belum diisi'} · {event?.dateLabel}</p></div><div className="connection connected"><BadgeCheck size={17} /><span>Tersimpan di perangkat</span></div></header> }

function ProductCard({ product, add }: { product: Product; add: (p: Product, id: string) => void }) {
  const stock = product.variants.reduce((s, v) => s + v.stock, 0)
  const primary = product.variants[0]
  const hasMultiple = product.variants.length > 1
  return (
    <article className={`product-card ${stock === 0 ? 'sold-out' : ''}`}>
      <div className="product-art" style={{ background: product.accent }}>
        {product.image ? (
          <img src={product.image} alt={product.name} className="product-art-img" />
        ) : (
          <Sparkles size={31} />
        )}
        {product.featured && <span className="popular-badge">Sering laku</span>}
        {stock === 0 && <span className="sold-badge">Habis</span>}
      </div>
      <div className="product-content">
        <p className="product-name">{product.name}</p>
        <p className="product-description">{product.description}</p>
        {hasMultiple ? (
          <div className="variant-list">
            {product.variants.map((v) => (
              <button
                key={v.id}
                disabled={!v.stock}
                onClick={() => add(product, v.id)}
                aria-label={`Tambah ${product.name}, varian ${v.name}, ${formatRupiah(v.price)}, stok ${v.stock}`}
              >
                <span>{v.name}<small>{v.stock ? `Stok ${v.stock}` : 'Habis'}</small></span>
                <b>{formatRupiah(v.price)}</b>
                <Plus size={17} />
              </button>
            ))}
          </div>
        ) : primary ? (
          <div className="product-single-row">
            <div className="product-meta-block">
              <span className="product-single-price">{formatRupiah(primary.price)}</span>
              <small className="product-single-stock">{primary.stock ? `Stok ${primary.stock}` : 'Habis'}</small>
            </div>
            <button
              className="button primary small product-single-btn"
              disabled={!primary.stock}
              onClick={() => add(product, primary.id)}
              aria-label={`Tambah ${product.name}, ${formatRupiah(primary.price)}, stok ${primary.stock}`}
            >
              <Plus size={16} />
              <span>Tambah</span>
            </button>
          </div>
        ) : null}
      </div>
    </article>
  )
}
function CartPanel({ cart, quantity, checkout, close }: { cart: CartItem[]; quantity: (id: string, n: number) => void; checkout: () => void; close?: () => void }) {
  const total = cart.reduce((s, x) => s + x.price * x.quantity, 0)
  return (
    <aside className={`cart-panel ${close ? 'cart-panel--mobile' : ''}`} aria-label="Keranjang belanja">
      <div className="cart-head">
        <div>
          <p className="eyebrow">Pesanan sekarang</p>
          <h2>Keranjang <span>{cart.reduce((s, x) => s + x.quantity, 0)}</span></h2>
        </div>
        {close && <button className="icon-button" onClick={close} aria-label="Tutup"><X /></button>}
      </div>
      <div className="cart-items">
        {!cart.length ? (
          <div className="empty-state"><ShoppingBag /><h3>Keranjang masih ringan</h3><p>Pilih produk untuk mulai.</p></div>
        ) : (
          cart.map((x) => {
            const hasVariant = x.variantName && x.variantName !== 'Default' && x.variantName !== x.productName
            return (
              <div className="cart-item" key={x.variantId}>
                <div>
                  <b>{x.productName}</b>
                  <small>{hasVariant ? `${x.variantName} · ` : ''}{formatRupiah(x.price)}</small>
                </div>
                <div className="quantity">
                  <button onClick={() => quantity(x.variantId, x.quantity - 1)} aria-label={`Kurangi ${x.productName}`}>
                    {x.quantity === 1 ? <Trash2 size={16} /> : <Minus size={16} />}
                  </button>
                  <span>{x.quantity}</span>
                  <button disabled={x.quantity >= x.stock} onClick={() => quantity(x.variantId, x.quantity + 1)} aria-label={`Tambah ${x.productName}`}>
                    <Plus size={16} />
                  </button>
                </div>
                <strong>{formatRupiah(x.price * x.quantity)}</strong>
              </div>
            )
          })
        )}
      </div>
      <div className="cart-summary">
        <div className="grand-total"><span>Total</span><strong>{formatRupiah(total)}</strong></div>
        <button className="button primary wide checkout-button" disabled={!cart.length} onClick={checkout}>Bayar sekarang</button>
      </div>
    </aside>
  )
}
function PosScreen({ data, cart, add, quantity, checkout, mobile, setMobile }: { data: BootstrapData; cart: CartItem[]; add: (p: Product, id: string) => void; quantity: (id: string, n: number) => void; checkout: () => void; mobile: boolean; setMobile: (v: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const products = useMemo(() => data.products.filter((p) => (category === 'all' || p.categoryId === category) && p.name.toLowerCase().includes(query.toLowerCase())), [data.products, category, query])
  return (
    <div className="pos-layout">
      <section className="catalog" id="main-content">
        <div className="catalog-top">
          <div>
            <h1>Pilih dagangan</h1>
            <p>Tap produk untuk langsung masuk keranjang.</p>
          </div>
          <label className="search-box">
            <Search size={20} />
            <span className="sr-only">Cari produk</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari produk…" />
          </label>
        </div>
        <div className="category-row">
          {data.categories.map((x) => (
            <button key={x.id} className={category === x.id ? 'active' : ''} onClick={() => setCategory(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
        {products.length ? (
          <div className="product-grid">
            {products.map((p) => <ProductCard key={p.id} product={p} add={add} />)}
          </div>
        ) : (
          <Empty title="Belum ada produk" text="Tambahkan produk dari menu Produk." />
        )}
      </section>
      <CartPanel cart={cart} quantity={quantity} checkout={checkout} />
      {mobile && (
        <div className="sheet-layer" onMouseDown={(e) => e.target === e.currentTarget && setMobile(false)}>
          <CartPanel cart={cart} quantity={quantity} checkout={checkout} close={() => setMobile(false)} />
        </div>
      )}
    </div>
  )
}

function Modal({ title, children, close, wide }: { title: string; children: ReactNode; close?: () => void; wide?: boolean }) { return <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && close?.()}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2>{close && <button className="icon-button" onClick={close} aria-label="Tutup"><X /></button>}</div>{children}</section></div> }
function CheckoutModal({ service, cart, eventId, success, close }: { service: LocalPosService; cart: CartItem[]; eventId: string; success: (t: Transaction) => void; close: () => void }) { const total = cart.reduce((s, x) => s + x.price * x.quantity, 0); const [cash, setCash] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const key = useRef(crypto.randomUUID()); const shortage = Math.max(0, total - cash); const change = Math.max(0, cash - total); const pay = async () => { if (busy || shortage) return; setBusy(true); setError(''); try { success(await service.createTransaction({ eventId, items: cart.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })), cashReceived: cash, idempotencyKey: key.current })) } catch (e) { setError(messageOf(e)); if (!isPosError(e, 'IDEMPOTENCY_CONFLICT')) key.current = crypto.randomUUID() } finally { setBusy(false) } }; return <Modal title="Pembayaran tunai" close={busy ? undefined : close}><div className="checkout-total"><span>Total tagihan</span><strong>{formatRupiah(total)}</strong><small>{cart.reduce((s, x) => s + x.quantity, 0)} barang</small></div>{error && <Alert>{error}</Alert>}<div className="payment-section"><label htmlFor="cash">Uang diterima</label><div className="money-input"><span>Rp</span><input id="cash" inputMode="numeric" autoFocus value={formatCashInput(cash)} onChange={(e) => setCash(Number(e.target.value.replace(/\D/g, '')))} /></div></div><div className="quick-cash">{quickCash(total).map((n) => <button key={n} className={cash === n ? 'active' : ''} onClick={() => setCash(n)}>{n === total ? <><Check size={17} />Uang pas</> : formatRupiah(n)}</button>)}</div><div className={`change-box ${shortage ? 'shortage' : ''}`} aria-live="polite"><span>{!cash ? 'Masukkan uang diterima' : shortage ? 'Masih kurang' : 'Kembalian'}</span><strong>{!cash ? '—' : formatRupiah(shortage || change)}</strong></div><div className="modal-actions"><button className="button secondary" onClick={close} disabled={busy}>Kembali</button><button className="button primary grow" onClick={pay} disabled={busy || !!shortage || !cash}>{busy ? <><span className="spinner" />Menyimpan…</> : <><BadgeCheck size={20} />Simpan pembayaran</>}</button></div></Modal> }
function ReceiptModal({ service, transaction, shop, close }: { service: LocalPosService; transaction: Transaction; shop: ShopSettings; close: () => void }) {
  const share = async () => shareFile(`${transaction.number}.txt`, await service.getReceiptText(transaction.id), 'text/plain')
  return (
    <Modal title="Transaksi berhasil" wide>
      <div className="success-hero">
        <span><Check size={30} /></span>
        <div>
          <p>Pesanan tersimpan di perangkat</p>
          <h3>{transaction.number}</h3>
          <small>{new Date(transaction.createdAt).toLocaleString('id-ID')}</small>
        </div>
      </div>
      <div className="receipt-preview">
        <div className="receipt-title">
          <BrandMark small />
          <div><b>{shop.shopName}</b><small>{shop.footer}</small></div>
        </div>
        <div className="receipt-lines">
          {transaction.items.map((x) => {
            const hasVariant = x.variantName && x.variantName !== 'Default' && x.variantName !== x.productName
            return (
              <div key={x.variantId}>
                <span>{x.productName}<small>{hasVariant ? `${x.variantName} · ` : ''}{x.quantity} × {formatRupiah(x.price)}</small></span>
                <b>{formatRupiah(x.price * x.quantity)}</b>
              </div>
            )
          })}
        </div>
        <div className="receipt-totals">
          <div><span>Total</span><b>{formatRupiah(transaction.total)}</b></div>
          <div><span>Tunai</span><b>{formatRupiah(transaction.cashReceived)}</b></div>
          <div className="change"><span>Kembalian</span><strong>{formatRupiah(transaction.change)}</strong></div>
        </div>
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={share}><Share2 size={19} />Bagikan struk</button>
        <button className="button primary grow" onClick={close}><Plus size={19} />Transaksi baru</button>
      </div>
    </Modal>
  )
}

function PageTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) { return <div className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</div> }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty-state page-empty"><Sparkles /><h3>{title}</h3><p>{text}</p></div> }
function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'danger' | 'warning' | 'neutral' }) { return <span className={`status-pill ${tone}`}>{children}</span> }
function SimpleForm({ title, children, submit, close, danger }: { title: string; children: ReactNode; submit: (e: FormEvent<HTMLFormElement>) => void | Promise<void>; close: () => void; danger?: boolean }) { return <Modal title={title} close={close}><form onSubmit={submit} className="stack-form">{children}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Batal</button><button className={`button ${danger ? 'danger' : 'primary'} grow`} type="submit">{danger ? 'Konfirmasi' : 'Simpan'}</button></div></form></Modal> }
function ConfirmDialog({ title, impact, confirmLabel, close, confirm }: { title: string; impact: string; confirmLabel: string; close: () => void; confirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await confirm() } finally { setBusy(false) } }
  return <Modal title={title} close={busy ? undefined : close}><div className="confirm-impact"><CircleAlert size={24} aria-hidden="true" /><div><b>Perhatikan dampaknya</b><p>{impact}</p></div></div><div className="modal-actions"><button className="button secondary" onClick={close} disabled={busy}>Batal</button><button className="button danger grow" onClick={run} disabled={busy}>{busy ? <><span className="spinner" />Memproses…</> : confirmLabel}</button></div></Modal>
}
function ProductsPage({ data, service, refresh }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void> }) {
  const [kind, setKind] = useState<'product' | 'category' | null>(null)
  const [pending, setPending] = useState<{ type: 'category' | 'product'; id: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [photo, setPhoto] = useState<string>('')

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('File harus berupa gambar (JPG, PNG, WebP).')
      return
    }
    try {
      const optimized = await optimizeImageFile(file, 640)
      setPhoto(optimized)
      setError('')
    } catch {
      setError('Gagal membaca gambar. Coba file lain.')
    }
  }

  const submitProduct = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget)
    try {
      await service.saveProduct({
        name: String(f.get('name')),
        categoryId: String(f.get('category')),
        description: String(f.get('description')),
        accent: '#b8e5ff',
        image: photo || undefined,
        variants: [{ name: 'Default', price: Number(f.get('price')), stock: Number(f.get('stock')) }],
      })
      setPhoto('')
      setKind(null)
      await refresh()
    } catch (x) {
      setError(messageOf(x))
    }
  }
  const submitCategory = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try { await service.saveCategory({ name: String(new FormData(e.currentTarget).get('name')), color: '#78b7ff' }); setKind(null); await refresh() } catch (x) { setError(messageOf(x)) }
  }
  const confirmPending = async () => {
    if (!pending) return
    try { if (pending.type === 'category') await service.deleteCategory(pending.id); else await service.archiveProduct(pending.id); setPending(null); await refresh() } catch (x) { setPending(null); setError(messageOf(x)) }
  }
  return (
    <section className="admin-page">
      <PageTitle eyebrow="Katalog lokal" title="Produk & kategori" action={<div className="action-row"><button className="button secondary" onClick={() => setKind('category')}><Plus />Kategori</button><button className="button primary" onClick={() => { setPhoto(''); setKind('product') }}><Plus />Produk baru</button></div>} />
      <div className="category-manager">{data.categories.filter((x) => x.id !== 'all').map((c) => <span key={c.id}>{c.name}<button aria-label={`Hapus kategori ${c.name}`} onClick={() => setPending({ type: 'category', id: c.id, name: c.name })}><X size={15} /></button></span>)}</div>
      {error && <Alert>{error}</Alert>}
      <div className="table-card">
        <table>
          <thead><tr><th>Produk</th><th>Kategori</th><th>Harga</th><th>Stok</th><th>Aksi</th></tr></thead>
          <tbody>
            {data.products.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="table-product">
                    {p.image ? (
                      <img src={p.image} alt={p.name} className="table-thumb" />
                    ) : (
                      <span style={{ background: p.accent }}><Sparkles size={18} /></span>
                    )}
                    <div>
                      <b>{p.name}</b>
                      {p.description && <small className="block">{p.description}</small>}
                    </div>
                  </div>
                </td>
                <td>{data.categories.find((c) => c.id === p.categoryId)?.name}</td>
                <td>{formatRupiah(Math.min(...p.variants.map((v) => v.price)))}</td>
                <td>{p.variants.reduce((s, v) => s + v.stock, 0)}</td>
                <td><button className="button ghost small" onClick={() => setPending({ type: 'product', id: p.id, name: p.name })}><Archive size={17} />Arsipkan</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {kind === 'product' && (
        <SimpleForm title="Produk baru" close={() => { setKind(null); setPhoto('') }} submit={submitProduct}>
          <div className="photo-upload-container">
            <span className="photo-upload-label">Foto produk</span>
            {photo ? (
              <div className="photo-preview-box">
                <img src={photo} alt="Pratinjau foto produk" className="photo-preview" />
                <div className="photo-preview-actions">
                  <label className="button secondary small change-photo-btn">
                    <Upload size={15} /> Ganti foto
                    <input type="file" accept="image/*" className="sr-only" onChange={handlePhotoSelect} />
                  </label>
                  <button type="button" className="button ghost small remove-photo-btn" onClick={() => setPhoto('')}>
                    <Trash2 size={15} /> Hapus
                  </button>
                </div>
              </div>
            ) : (
              <label className="photo-dropzone">
                <ImagePlus size={28} />
                <span>Unggah foto produk</span>
                <small>JPG, PNG, WebP (maks. 5MB)</small>
                <input type="file" accept="image/*" className="sr-only" onChange={handlePhotoSelect} />
              </label>
            )}
          </div>
          <label>Nama produk<input name="name" autoFocus required placeholder="Contoh: Acrylic Keychain" /></label>
          <label>Kategori<select name="category" required>{data.categories.filter((x) => x.id !== 'all').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Deskripsi<input name="description" placeholder="Contoh: Art paper 260 gsm, laminasi doff" /></label>
          <div className="form-grid form-grid-2">
            <label>Harga (Rp)<input name="price" type="number" min="0" placeholder="25000" required /></label>
            <label>Stok awal<input name="stock" type="number" min="0" placeholder="10" required /></label>
          </div>
        </SimpleForm>
      )}
      {kind === 'category' && <SimpleForm title="Kategori baru" close={() => setKind(null)} submit={submitCategory}><label>Nama kategori<input name="name" autoFocus required /></label></SimpleForm>}
      {pending && <ConfirmDialog title={pending.type === 'category' ? `Hapus kategori ${pending.name}?` : `Arsipkan ${pending.name}?`} impact={pending.type === 'category' ? 'Kategori akan dihapus permanen. Kategori yang masih dipakai produk aktif tidak dapat dihapus.' : 'Produk tidak lagi muncul di kasir, tetapi transaksi lama dan catatan stok tetap tersimpan.'} confirmLabel={pending.type === 'category' ? 'Hapus kategori' : 'Arsipkan produk'} close={() => setPending(null)} confirm={confirmPending} />}
    </section>
  )
}
function StockPage({ data, service, refresh }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void> }) {
  const [variant, setVariant] = useState<{ product: Product; id: string } | null>(null)
  const [error, setError] = useState('')
  const variants = data.products.flatMap((p) => p.variants.map((v) => ({ ...v, product: p })))
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if (!variant) return
    const f = new FormData(e.currentTarget)
    try {
      await service.adjustStock(variant.product.id, variant.id, Number(f.get('delta')), String(f.get('reason')))
      setVariant(null)
      await refresh()
    } catch (x) {
      setError(messageOf(x))
    }
  }
  return (
    <section className="admin-page">
      <PageTitle eyebrow="Inventori" title="Stok booth" />
      {error && <Alert>{error}</Alert>}
      <div className="stock-grid">
        <div className="table-card">
          <table>
            <thead><tr><th>Produk</th><th>SKU</th><th>Stok</th><th>Aksi</th></tr></thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div className="table-product">
                      {v.product.image ? (
                        <img src={v.product.image} alt={v.product.name} className="table-thumb" />
                      ) : (
                        <span style={{ background: v.product.accent }}><Sparkles size={18} /></span>
                      )}
                      <div>
                        <b>{v.product.name}</b>
                        {v.name && v.name !== 'Default' && v.name !== v.product.name && <small className="block">{v.name}</small>}
                      </div>
                    </div>
                  </td>
                  <td><code>{v.sku || '—'}</code></td>
                  <td className="number-cell">{v.stock}</td>
                  <td><button className="button secondary small" onClick={() => setVariant({ product: v.product, id: v.id })}>Sesuaikan</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="history-card">
          <div className="card-heading"><h2>Penyesuaian terbaru</h2></div>
          {data.stockAdjustments.map((x) => (
            <div className="timeline-item" key={x.id}>
              <span className={x.delta > 0 ? 'plus' : 'minus'}>{x.delta > 0 ? '+' : ''}{x.delta}</span>
              <div>
                <b>{x.productName}</b>
                <p>{x.variantName && x.variantName !== 'Default' ? `${x.variantName} · ` : ''}{x.reason}</p>
                <small>{new Date(x.createdAt).toLocaleString('id-ID')} · {x.actor}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
      {variant && (
        <SimpleForm title="Sesuaikan stok" close={() => setVariant(null)} submit={submit}>
          <p><b>{variant.product.name}</b></p>
          <label>Perubahan stok<input name="delta" type="number" autoFocus placeholder="Contoh: 5 atau -2" required /></label>
          <label>Alasan<input name="reason" required placeholder="Contoh: Restock booth" /></label>
        </SimpleForm>
      )}
    </section>
  )
}
function EventsPage({ data, service, refresh, select }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void>; select: (id: string) => void }) { const [open, setOpen] = useState(false); const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); const event = await service.saveEvent({ name: String(f.get('name')), venue: String(f.get('venue')), dateLabel: String(f.get('date')) }); await service.setActiveEvent(event.id); setOpen(false); select(event.id); await refresh() }; return <section className="admin-page"><PageTitle eyebrow="Periode penjualan" title="Pengelolaan event" action={<button className="button primary" onClick={() => setOpen(true)}><Plus />Event baru</button>} /><div className="event-grid">{data.events.map((x) => <article className={`event-card ${x.active ? 'active' : ''}`} key={x.id}><CalendarDays /><h2>{x.name}</h2><p>{x.venue || 'Lokasi belum diisi'} · {x.dateLabel}</p><div>{x.active ? <StatusPill tone="success">Sedang aktif</StatusPill> : <button className="button secondary small" onClick={async () => { await service.setActiveEvent(x.id); select(x.id); await refresh() }}>Aktifkan</button>}</div></article>)}</div>{open && <SimpleForm title="Event baru" close={() => setOpen(false)} submit={submit}><label>Nama event<input name="name" autoFocus required /></label><label>Lokasi<input name="venue" /></label><label>Tanggal / label<input name="date" placeholder="16 Okt 2026" required /></label></SimpleForm>}</section> }
function ReportsPage({ data, service, eventId }: { data: BootstrapData; service: LocalPosService; eventId: string }) { const [report, setReport] = useState<EventReport | null>(null); useEffect(() => { if (eventId) service.getEventReport(eventId).then(setReport) }, [service, eventId, data.transactions]); if (!report) return <section className="admin-page"><Empty title="Menyiapkan laporan" text="Menghitung dari transaksi tersimpan…" /></section>; const event = data.events.find((x) => x.id === eventId); return <section className="admin-page"><PageTitle eyebrow={event?.name ?? 'Event'} title="Laporan event" /><div className="metric-grid"><Metric icon={<CircleDollarSign />} label="Omzet" value={formatRupiah(report.revenue)} hint={`${report.transactionCount} transaksi tersimpan`} /><Metric icon={<ReceiptText />} label="Rata-rata" value={formatRupiah(report.averageTicket)} hint={`${report.voidCount} transaksi batal`} /><Metric icon={<Package />} label="Barang terjual" value={String(report.itemsSold)} hint="Tidak termasuk transaksi batal" /></div><div className="report-grid"><article className="chart-card"><div className="card-heading"><h2>Penjualan per jam</h2></div><div className="bar-chart">{report.byHour.map((x) => <div className="bar-wrap" key={x.hour}><span className="bar" style={{ height: `${report.revenue ? Math.max(5, x.revenue / report.revenue * 100) : 5}%` }} /><small>{x.hour}</small></div>)}</div></article><article className="ranking-card"><div className="card-heading"><h2>Produk terlaris</h2></div>{report.topProducts.map((x, i) => <div className="rank-row" key={x.productId}><span>{i + 1}</span><div><b>{x.productName}</b><small>{formatRupiah(x.revenue)}</small></div><strong>{x.quantity}</strong></div>)}</article></div></section> }
function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) { return <article className="metric-card"><span>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{hint}</small></div></article> }
function MoreMenu({ navigate }: { navigate: (screen: Screen) => void }) { return <section className="admin-page mobile-more"><PageTitle eyebrow="Menu lainnya" title="Kelola booth" /><div className="more-grid">{NAV.slice(3).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)}><Icon size={23} /><span>{label}</span></button>)}</div></section> }
function TransactionsPage({ data, service, refresh, receipt }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void>; receipt: (t: Transaction) => void }) {
  const [target, setTarget] = useState<Transaction | null>(null); const [error, setError] = useState('')
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!target) return; const f = new FormData(e.currentTarget); try { await service.voidTransaction(target.id, String(f.get('reason'))); setTarget(null); await refresh() } catch (x) { setError(messageOf(x)) } }
  return <section className="admin-page"><PageTitle eyebrow="Jejak penjualan" title="Riwayat transaksi" />{error && <Alert>{error}</Alert>}<div className="table-card"><table><thead><tr><th>Nomor</th><th>Waktu</th><th>Kasir</th><th>Total</th><th>Status</th><th>Aksi</th></tr></thead><tbody>{data.transactions.map((t) => <tr key={t.id}><td><b>{t.number}</b>{t.voidReason && <small className="block void-reason">Alasan: {t.voidReason}</small>}</td><td>{new Date(t.createdAt).toLocaleString('id-ID')}</td><td>{t.cashierName}</td><td>{formatRupiah(t.total)}</td><td><StatusPill tone={t.status === 'void' ? 'danger' : 'success'}>{t.status === 'void' ? 'Batal' : 'Selesai'}</StatusPill></td><td><div className="action-row"><button className="button ghost small" onClick={() => receipt(t)}><ReceiptText size={17} />Struk</button>{t.status !== 'void' && <button className="button danger small" onClick={() => setTarget(t)}>Batalkan</button>}</div></td></tr>)}</tbody></table></div>{target && <SimpleForm title={`Batalkan ${target.number}?`} danger close={() => setTarget(null)} submit={submit}><div className="confirm-impact"><CircleAlert size={24} aria-hidden="true" /><div><b>Transaksi akan dibatalkan</b><p>Stok seluruh item dikembalikan. Transaksi tetap ada di riwayat dengan alasan pembatalan dan tidak dihitung sebagai omzet.</p></div></div><label>Alasan pembatalan<input name="reason" autoFocus required minLength={3} placeholder="Contoh: salah pilih varian" /></label></SimpleForm>}</section>
}
function SettingsPage({ service, settings, setSettings }: { service: LocalPosService; settings: ShopSettings; setSettings: (s: ShopSettings) => void }) {
  const [notice, setNotice] = useState(''); const [error, setError] = useState(''); const [restore, setRestore] = useState(false)
  const save = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { const next = await service.saveSettings({ shopName: String(f.get('shop')), defaultCashier: String(f.get('cashier')), footer: String(f.get('footer')), receiptPrefix: String(f.get('prefix')) }); setSettings(next); setNotice('Pengaturan disimpan di perangkat.'); setError('') } catch (x) { setError(messageOf(x)) } }
  const backup = async () => { try { const content = JSON.stringify(await service.exportBackup(), null, 2); const result = await saveToDevice(backupFileName(), content); setNotice(result.saved ? `Backup disimpan: ${result.location}` : 'Penyimpanan dibatalkan.'); setError('') } catch (x) { setError(messageOf(x)) } }
  const doRestore = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const file = new FormData(e.currentTarget).get('file'); try { if (!(file instanceof File) || !file.size) throw new Error('Pilih file backup JSON.'); await service.restoreBackup(await file.text()); setRestore(false); window.location.reload() } catch (x) { setError(messageOf(x)) } }
  return <section className="admin-page"><PageTitle eyebrow="Preferensi booth" title="Pengaturan" />{notice && <Alert tone="success">{notice}</Alert>}{error && <Alert>{error}</Alert>}<div className="settings-grid"><form className="settings-card stack-form" onSubmit={save}><div className="card-heading"><div><h2>Identitas booth</h2><p>Tampil di aplikasi dan struk</p></div><Sparkles /></div><label>Nama booth<input name="shop" defaultValue={settings.shopName} required /></label><label>Nama kasir bawaan<input name="cashier" defaultValue={settings.defaultCashier} required /></label><label>Pesan struk<input name="footer" defaultValue={settings.footer} required /></label><label>Prefix struk<input name="prefix" defaultValue={settings.receiptPrefix} required /></label><button className="button primary" type="submit">Simpan pengaturan</button></form><article className="settings-card"><div className="card-heading"><div><h2>Backup lokal</h2><p>Simpan di luar penyimpanan aplikasi</p></div><Download /></div><p>Ekspor backup secara rutin ke Dokumen agar data tetap bisa dipulihkan bila aplikasi dihapus atau HP bermasalah.</p><div className="action-row"><button className="button primary" onClick={backup}><Download size={18} />Ekspor backup</button><button className="button secondary" onClick={() => setRestore(true)}><FileUp size={18} />Restore</button></div></article><article className="settings-card"><div className="card-heading"><div><h2>Mode offline</h2><p>Tidak ada server yang diperlukan</p></div><WifiOff /></div><p>Produk, event, transaksi, stok, dan laporan disimpan langsung di HP ini.</p></article></div>{restore && <SimpleForm title="Restore backup?" danger close={() => setRestore(false)} submit={doRestore}><div className="confirm-impact"><CircleAlert size={24} aria-hidden="true" /><div><b>Seluruh data aktif akan diganti</b><p>Produk, stok, event, transaksi, dan pengaturan saat ini akan ditimpa oleh isi file. Ekspor backup sekarang terlebih dahulu bila data lama masih dibutuhkan.</p></div></div><label>File backup JSON<input name="file" type="file" accept="application/json,.json" required autoFocus /></label></SimpleForm>}</section>
}

export default function App({ service = posService }: { service?: LocalPosService }) {
  const [boot, setBoot] = useState<'loading' | 'app' | 'error'>('loading'); const [bootError, setBootError] = useState(''); const [data, setData] = useState<BootstrapData | null>(null); const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [screen, setScreen] = useState<Screen>('pos'); const [eventId, setEventId] = useState(''); const [cart, setCart] = useState<CartItem[]>([]); const [checkout, setCheckout] = useState(false); const [receipt, setReceipt] = useState<Transaction | null>(null); const [mobile, setMobile] = useState(false)
  useEffect(() => { let active = true; (async () => { try { await service.ready(); const [next, nextSettings] = await Promise.all([service.getBootstrap(), service.getSettings()]); if (!active) return; setData(next); setSettings(nextSettings); setEventId(next.events.find((x) => x.active)?.id || next.events[0]?.id || ''); setBoot('app') } catch (reason) { if (active) { setBootError(messageOf(reason)); setBoot('error') } } })(); return () => { active = false } }, [service])
  const refresh = async () => { const next = await service.getBootstrap(); setData(next); setEventId((id) => id || next.events.find((x) => x.active)?.id || next.events[0]?.id || '') }
  const selectEvent = async (id: string) => { await service.setActiveEvent(id); setEventId(id); setCart([]); await refresh() }
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'F2' && cart.length && screen === 'pos') { e.preventDefault(); setCheckout(true); setMobile(false) } if (e.key === 'Escape') { setCheckout(false); setMobile(false) } }; addEventListener('keydown', key); return () => removeEventListener('keydown', key) }, [cart.length, screen])
  if (boot === 'loading') return <div className="loading-screen"><BrandMark /><span className="spinner dark" /><p>Menyiapkan data offline…</p></div>
  if (boot === 'error') return <main className="loading-screen"><BrandMark /><Alert>{bootError || 'Data lokal tidak dapat dibuka.'}</Alert><button className="button primary" onClick={() => window.location.reload()}>Coba lagi</button></main>
  if (!data || !settings) return <div className="loading-screen"><span className="spinner dark" /></div>
  const add = (p: Product, id: string) => { const v = p.variants.find((x) => x.id === id); if (!v?.stock) return; setCart((old) => { const hit = old.find((x) => x.variantId === id); return hit ? old.map((x) => x.variantId === id ? { ...x, quantity: Math.min(x.quantity + 1, x.stock) } : x) : [...old, { productId: p.id, productName: p.name, variantId: id, variantName: v.name, price: v.price, quantity: 1, stock: v.stock }] }) }
  const quantity = (id: string, n: number) => setCart((old) => n <= 0 ? old.filter((x) => x.variantId !== id) : old.map((x) => x.variantId === id ? { ...x, quantity: Math.min(n, x.stock) } : x))
  const done = async (t: Transaction) => { await refresh(); setCart([]); setCheckout(false); setMobile(false); setReceipt(t) }
  const navigate = (s: Screen) => { setScreen(s); setMobile(false); scrollTo({ top: 0, behavior: 'smooth' }) }
  return <div className="app-shell"><a className="skip-link" href="#main-content">Lewati ke konten utama</a><Sidebar screen={screen} setScreen={navigate} cashierName={settings.defaultCashier} shopName={settings.shopName} /><main className="workspace"><AppHeader events={data.events} event={data.events.find((x) => x.id === eventId)} change={selectEvent} />{screen === 'pos' && <PosScreen data={data} cart={cart} add={add} quantity={quantity} checkout={() => setCheckout(true)} mobile={mobile} setMobile={setMobile} />}{screen === 'products' && <ProductsPage data={data} service={service} refresh={refresh} />}{screen === 'stock' && <StockPage data={data} service={service} refresh={refresh} />}{screen === 'events' && <EventsPage data={data} service={service} refresh={refresh} select={setEventId} />}{screen === 'reports' && <ReportsPage data={data} service={service} eventId={eventId} />}{screen === 'transactions' && <TransactionsPage data={data} service={service} refresh={refresh} receipt={setReceipt} />}{screen === 'settings' && <><MoreMenu navigate={navigate} /><SettingsPage service={service} settings={settings} setSettings={setSettings} /></>}</main><MobileNav screen={screen} setScreen={navigate} cartCount={cart.reduce((s, x) => s + x.quantity, 0)} openCart={() => setMobile(true)} />{checkout && <CheckoutModal service={service} cart={cart} eventId={eventId} success={done} close={() => setCheckout(false)} />}{receipt && <ReceiptModal service={service} transaction={receipt} shop={settings} close={() => { setReceipt(null); setScreen('pos') }} />}</div>
}
