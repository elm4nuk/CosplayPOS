import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertTriangle, Archive, BadgeCheck, Banknote, BarChart3, CalendarDays, Check, ChevronDown, CircleAlert,
  CircleDollarSign, Download, FileUp, Gift, History, ImagePlus, LayoutGrid,
  Minus, Package, Pencil, Plus, QrCode, ReceiptText, Search, Settings, Share2,
  ShoppingBag, Sparkles, Tag, Target, Trash2, TrendingUp, Trophy, Upload, WifiOff, X, Zap,
} from 'lucide-react'
import { backupFileName, saveToDevice, shareFile } from './platform/files'
import { optimizeImageFile } from './platform/images'
import { isPosError, posService, type EventComparisonReport, type EventReport, type LocalPosService, type ShopSettings } from './services'
import type { BoothEvent, BootstrapData, CartItem, Product, PromoBundle, PromoBundleItem, Transaction } from './types'

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
  const isLowStock = stock > 0 && stock <= 3
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
        {isLowStock && (
          <span className="low-stock-badge">
            <AlertTriangle size={12} /> Sisa {stock}
          </span>
        )}
      </div>
      <div className="product-content">
        <p className="product-name">{product.name}</p>
        <p className="product-description">{product.description}</p>
        {hasMultiple ? (
          <div className="variant-list">
            {product.variants.map((v) => {
              const vLow = v.stock > 0 && v.stock <= 3
              return (
                <button
                  key={v.id}
                  disabled={!v.stock}
                  onClick={() => add(product, v.id)}
                  aria-label={`Tambah ${product.name}, varian ${v.name}, ${formatRupiah(v.price)}, stok ${v.stock}`}
                >
                  <span>
                    {v.name}
                    <small className={vLow ? 'low-stock-text' : ''}>
                      {v.stock === 0 ? 'Habis' : vLow ? `Sisa ${v.stock}!` : `Stok ${v.stock}`}
                    </small>
                  </span>
                  <b>{formatRupiah(v.price)}</b>
                  <Plus size={17} />
                </button>
              )
            })}
          </div>
        ) : primary ? (
          <div className="product-single-row">
            <div className="product-meta-block">
              <span className="product-single-price">{formatRupiah(primary.price)}</span>
              <small className={`product-single-stock ${isLowStock ? 'low-stock-text' : ''}`}>
                {primary.stock === 0 ? 'Habis' : isLowStock ? `Sisa ${primary.stock} (Menipis)` : `Stok ${primary.stock}`}
              </small>
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
function BundleCard({
  bundle,
  products,
  addBundle,
}: {
  bundle: PromoBundle
  products: Product[]
  addBundle: (b: PromoBundle) => void
}) {
  let normalTotal = 0
  let maxBundleStock = Infinity
  const resolvedItems = bundle.items.map((item) => {
    const product = products.find((p) => p.id === item.productId)
    const variant = product?.variants.find((v) => v.id === item.variantId)
    const price = variant?.price ?? 0
    const stock = variant?.stock ?? 0
    normalTotal += price * item.quantity
    maxBundleStock = Math.min(maxBundleStock, Math.floor(stock / item.quantity))
    return { item, product, variant, price, stock }
  })
  if (maxBundleStock === Infinity) maxBundleStock = 0
  const savings = Math.max(0, normalTotal - bundle.price)
  const isAvailable = maxBundleStock > 0

  return (
    <article className={`product-card bundle-card ${!isAvailable ? 'sold-out' : ''}`}>
      <div className="product-art bundle-art" style={{ background: 'linear-gradient(135deg, #fce7f3 0%, #ede9fe 100%)' }}>
        <Gift size={32} className="bundle-art-icon" />
        <span className="bundle-badge">🎁 Promo Bundle</span>
        {savings > 0 && <span className="savings-badge">Hemat {formatRupiah(savings)}</span>}
        {!isAvailable ? (
          <span className="sold-badge">Habis</span>
        ) : maxBundleStock <= 3 ? (
          <span className="low-stock-badge"><AlertTriangle size={12} /> Sisa {maxBundleStock}</span>
        ) : (
          <span className="bundle-stock-badge">Sisa {maxBundleStock} paket</span>
        )}
      </div>
      <div className="product-content">
        <p className="product-name">{bundle.name}</p>
        <p className="product-description">{bundle.description || 'Paket promo hemat pilihan booth'}</p>
        <div className="bundle-items-summary">
          {resolvedItems.map(({ item, product, variant }) => (
            <span key={item.variantId} className="bundle-item-tag">
              {item.quantity}× {product?.name || 'Item'}{variant?.name && variant.name !== 'Default' ? ` (${variant.name})` : ''}
            </span>
          ))}
        </div>
        <div className="product-single-row">
          <div className="product-meta-block">
            <span className="product-single-price">{formatRupiah(bundle.price)}</span>
            {normalTotal > bundle.price && (
              <small className="bundle-normal-price">
                <s>{formatRupiah(normalTotal)}</s>
              </small>
            )}
          </div>
          <button
            className="button primary small product-single-btn bundle-add-btn"
            disabled={!isAvailable}
            onClick={() => addBundle(bundle)}
            aria-label={`Tambah ${bundle.name}, ${formatRupiah(bundle.price)}`}
          >
            <Plus size={16} />
            <span>Tambah</span>
          </button>
        </div>
      </div>
    </article>
  )
}

function CartPanel({
  cart,
  quantity,
  checkout,
  close,
  appliedPromo,
  removePromo,
  availablePromo,
  applyPromo,
}: {
  cart: CartItem[]
  quantity: (id: string, n: number) => void
  checkout: () => void
  close?: () => void
  appliedPromo?: { id: string; name: string; discount: number } | null
  removePromo?: () => void
  availablePromo?: PromoBundle | null
  applyPromo?: (b: PromoBundle) => void
}) {
  const subtotal = cart.reduce((s, x) => s + x.price * x.quantity, 0)
  const discount = appliedPromo ? Math.min(subtotal, appliedPromo.discount) : 0
  const total = Math.max(0, subtotal - discount)

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
        {appliedPromo && discount > 0 ? (
          <div className="cart-promo-pill">
            <div className="cart-promo-info">
              <Gift size={16} />
              <div>
                <b>{appliedPromo.name}</b>
                <small>Hemat {formatRupiah(discount)}</small>
              </div>
            </div>
            {removePromo && (
              <button
                type="button"
                className="cart-promo-remove"
                onClick={removePromo}
                title="Hapus promo bundle"
                aria-label="Hapus promo bundle"
              >
                <X size={15} />
              </button>
            )}
          </div>
        ) : availablePromo && applyPromo ? (
          <div className="cart-promo-suggestion">
            <div className="cart-promo-suggestion-text">
              <Sparkles size={16} />
              <span>Promo <b>{availablePromo.name}</b> tersedia!</span>
            </div>
            <button
              type="button"
              className="button secondary small apply-promo-btn"
              onClick={() => applyPromo(availablePromo)}
            >
              Terapkan
            </button>
          </div>
        ) : null}

        {discount > 0 ? (
          <div className="grand-total-breakdown">
            <div className="subtotal-row"><span>Subtotal</span><span>{formatRupiah(subtotal)}</span></div>
            <div className="discount-row"><span>Diskon Bundle</span><span>-{formatRupiah(discount)}</span></div>
            <div className="grand-total"><span>Total</span><strong>{formatRupiah(total)}</strong></div>
          </div>
        ) : (
          <div className="grand-total"><span>Total</span><strong>{formatRupiah(total)}</strong></div>
        )}
        <button className="button primary wide checkout-button" disabled={!cart.length} onClick={checkout}>Bayar sekarang</button>
      </div>
    </aside>
  )
}

function PosScreen({
  data,
  cart,
  add,
  addBundle,
  quantity,
  checkout,
  mobile,
  setMobile,
  appliedPromo,
  removePromo,
  availablePromo,
  applyPromo,
}: {
  data: BootstrapData
  cart: CartItem[]
  add: (p: Product, id: string) => void
  addBundle: (b: PromoBundle) => void
  quantity: (id: string, n: number) => void
  checkout: () => void
  mobile: boolean
  setMobile: (v: boolean) => void
  appliedPromo: { id: string; name: string; discount: number } | null
  removePromo: () => void
  availablePromo: PromoBundle | null
  applyPromo: (b: PromoBundle) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const activeBundles = useMemo(() => data.bundles?.filter((b) => b.active) ?? [], [data.bundles])

  const products = useMemo(() => data.products.filter((p) => (category === 'all' || p.categoryId === category) && p.name.toLowerCase().includes(query.toLowerCase())), [data.products, category, query])
  const filteredBundles = useMemo(() => activeBundles.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()) || (b.description && b.description.toLowerCase().includes(query.toLowerCase()))), [activeBundles, query])

  return (
    <div className="pos-layout">
      <section className="catalog" id="main-content">
        <div className="catalog-top">
          <div>
            <h1>Pilih dagangan</h1>
            <p>Tap produk atau promo bundle untuk langsung masuk keranjang.</p>
          </div>
          <label className="search-box">
            <Search size={20} />
            <span className="sr-only">Cari produk</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari produk atau bundle…" />
          </label>
        </div>
        <div className="category-row" role="tablist" aria-label="Filter kategori dagangan">
          {data.categories.map((x) => {
            const count = x.id === 'all'
              ? data.products.length
              : data.products.filter((p) => p.categoryId === x.id).length
            return (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={category === x.id}
                className={category === x.id ? 'active' : ''}
                onClick={() => setCategory(x.id)}
              >
                <span>{x.name}</span>
                <span className="category-pill-count">{count}</span>
              </button>
            )
          })}
          {activeBundles.length > 0 && (
            <button
              key="bundles"
              type="button"
              role="tab"
              aria-selected={category === 'bundle-promo'}
              className={`category-pill-bundle ${category === 'bundle-promo' ? 'active' : ''}`}
              onClick={() => setCategory('bundle-promo')}
            >
              <Gift size={15} />
              <span>Promo Bundle</span>
              <span className="category-pill-count">{activeBundles.length}</span>
            </button>
          )}
        </div>
        {category === 'bundle-promo' ? (
          filteredBundles.length ? (
            <div className="product-grid">
              {filteredBundles.map((b) => (
                <BundleCard key={b.id} bundle={b} products={data.products} addBundle={addBundle} />
              ))}
            </div>
          ) : (
            <Empty
              title="Promo bundle tidak ditemukan"
              text={query ? `Tidak ada promo bundle dengan kata kunci "${query}".` : 'Belum ada promo bundle aktif.'}
              action={
                query && (
                  <button type="button" className="button secondary small" onClick={() => setQuery('')}>
                    Tampilkan semua bundle
                  </button>
                )
              }
            />
          )
        ) : (products.length || (category === 'all' && filteredBundles.length)) ? (
          <div className="product-grid">
            {category === 'all' && filteredBundles.map((b) => (
              <BundleCard key={b.id} bundle={b} products={data.products} addBundle={addBundle} />
            ))}
            {products.map((p) => <ProductCard key={p.id} product={p} add={add} />)}
          </div>
        ) : (
          <Empty
            title={category !== 'all' || query ? 'Produk tidak ditemukan' : 'Belum ada produk'}
            text={
              category !== 'all' || query
                ? `Tidak ada produk di kategori "${data.categories.find((c) => c.id === category)?.name || category}"${query ? ` dengan kata kunci "${query}"` : ''}.`
                : 'Tambahkan produk dari menu Produk.'
            }
            action={
              (category !== 'all' || query) && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => { setCategory('all'); setQuery('') }}
                >
                  Tampilkan semua produk
                </button>
              )
            }
          />
        )}
      </section>
      <CartPanel
        cart={cart}
        quantity={quantity}
        checkout={checkout}
        appliedPromo={appliedPromo}
        removePromo={removePromo}
        availablePromo={availablePromo}
        applyPromo={applyPromo}
      />
      {mobile && (
        <div className="sheet-layer" onMouseDown={(e) => e.target === e.currentTarget && setMobile(false)}>
          <CartPanel
            cart={cart}
            quantity={quantity}
            checkout={checkout}
            close={() => setMobile(false)}
            appliedPromo={appliedPromo}
            removePromo={removePromo}
            availablePromo={availablePromo}
            applyPromo={applyPromo}
          />
        </div>
      )}
    </div>
  )
}

function Modal({ title, children, close, wide }: { title: string; children: ReactNode; close?: () => void; wide?: boolean }) { return <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && close?.()}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2>{close && <button className="icon-button" onClick={close} aria-label="Tutup"><X /></button>}</div>{children}</section></div> }

function CheckoutModal({
  service,
  cart,
  eventId,
  settings,
  success,
  close,
  discount = 0,
  promoName,
}: {
  service: LocalPosService
  cart: CartItem[]
  eventId: string
  settings?: ShopSettings
  success: (t: Transaction) => void
  close: () => void
  discount?: number
  promoName?: string
}) {
  const subtotal = cart.reduce((s, x) => s + x.price * x.quantity, 0)
  const actualDiscount = Math.min(subtotal, Math.max(0, discount))
  const total = subtotal - actualDiscount
  const [method, setMethod] = useState<'cash' | 'qris'>('cash')
  const [cash, setCash] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = useRef(crypto.randomUUID())
  const shortage = Math.max(0, total - cash)
  const change = Math.max(0, cash - total)

  const payCash = async () => {
    if (busy || shortage) return
    setBusy(true)
    setError('')
    try {
      success(
        await service.createTransaction({
          eventId,
          items: cart.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
          cashReceived: cash,
          paymentMethod: 'cash',
          discount: actualDiscount,
          promoName,
          idempotencyKey: key.current,
        })
      )
    } catch (e) {
      setError(messageOf(e))
      if (!isPosError(e, 'IDEMPOTENCY_CONFLICT')) key.current = crypto.randomUUID()
    } finally {
      setBusy(false)
    }
  }

  const payQris = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      success(
        await service.createTransaction({
          eventId,
          items: cart.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
          cashReceived: total,
          paymentMethod: 'qris',
          discount: actualDiscount,
          promoName,
          idempotencyKey: key.current,
        })
      )
    } catch (e) {
      setError(messageOf(e))
      if (!isPosError(e, 'IDEMPOTENCY_CONFLICT')) key.current = crypto.randomUUID()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={method === 'cash' ? 'Pembayaran Tunai' : 'Pembayaran QRIS'} close={busy ? undefined : close}>
      <div className="checkout-total">
        <span>Total tagihan</span>
        <strong>{formatRupiah(total)}</strong>
        <div className="checkout-meta-breakdown">
          {actualDiscount > 0 ? (
            <span className="checkout-discount-badge">
              Subtotal {formatRupiah(subtotal)} · Diskon {formatRupiah(actualDiscount)} ({promoName || 'Bundle'})
            </span>
          ) : null}
          <small>{cart.reduce((s, x) => s + x.quantity, 0)} barang</small>
        </div>
      </div>
      <div className="payment-tabs" role="tablist" aria-label="Metode pembayaran">
        <button
          type="button"
          role="tab"
          aria-selected={method === 'cash'}
          className={`payment-tab ${method === 'cash' ? 'active' : ''}`}
          onClick={() => setMethod('cash')}
        >
          <Banknote size={18} />
          <span>Tunai</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === 'qris'}
          className={`payment-tab ${method === 'qris' ? 'active' : ''}`}
          onClick={() => setMethod('qris')}
        >
          <QrCode size={18} />
          <span>QRIS</span>
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {method === 'cash' ? (
        <>
          <div className="payment-section">
            <label htmlFor="cash">Uang diterima</label>
            <div className="money-input">
              <span>Rp</span>
              <input
                id="cash"
                inputMode="numeric"
                autoFocus
                value={formatCashInput(cash)}
                onChange={(e) => setCash(Number(e.target.value.replace(/\D/g, '')))}
              />
            </div>
          </div>
          <div className="quick-cash">
            {quickCash(total).map((n) => (
              <button key={n} className={cash === n ? 'active' : ''} onClick={() => setCash(n)}>
                {n === total ? (
                  <>
                    <Check size={17} />
                    Uang pas
                  </>
                ) : (
                  formatRupiah(n)
                )}
              </button>
            ))}
          </div>
          <div className={`change-box ${shortage ? 'shortage' : ''}`} aria-live="polite">
            <span>{!cash ? 'Masukkan uang diterima' : shortage ? 'Masih kurang' : 'Kembalian'}</span>
            <strong>{!cash ? '—' : formatRupiah(shortage || change)}</strong>
          </div>
          <div className="modal-actions">
            <button className="button secondary" onClick={close} disabled={busy}>
              Kembali
            </button>
            <button className="button primary grow" onClick={payCash} disabled={busy || !!shortage || !cash}>
              {busy ? (
                <>
                  <span className="spinner" />
                  Menyimpan…
                </>
              ) : (
                <>
                  <BadgeCheck size={20} />
                  Simpan pembayaran
                </>
              )}
            </button>
          </div>
        </>
      ) : (
        <div className="qris-checkout-container">
          {settings?.qrisImage ? (
            <div className="qris-checkout-display">
              <img src={settings.qrisImage} alt="QRIS booth" className="qris-checkout-img" />
              <p className="qris-checkout-caption">
                Scan kode QRIS di atas untuk membayar <b>{formatRupiah(total)}</b>
              </p>
            </div>
          ) : (
            <div className="qris-missing-display">
              <QrCode size={48} className="qris-missing-icon" />
              <p className="qris-missing-title">Foto QRIS belum diunggah</p>
              <small className="qris-missing-text">
                Anda dapat mengunggah foto QRIS di menu <b>Pengaturan</b> agar langsung tampil saat checkout.
                Bila pembeli sudah scan QRIS fisik booth, tekan tombol di bawah untuk konfirmasi.
              </small>
            </div>
          )}
          <div className="modal-actions">
            <button className="button secondary" onClick={close} disabled={busy}>
              Kembali
            </button>
            <button className="button primary grow" onClick={payQris} disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" />
                  Menyimpan…
                </>
              ) : (
                <>
                  <BadgeCheck size={20} />
                  Konfirmasi Pembayaran QRIS
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

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
          {transaction.discount && transaction.discount > 0 ? (
            <>
              <div><span>Subtotal</span><b>{formatRupiah(transaction.subtotal ?? (transaction.total + transaction.discount))}</b></div>
              <div className="receipt-discount-line"><span>Diskon {transaction.promoName ? `(${transaction.promoName})` : ''}</span><b>-{formatRupiah(transaction.discount)}</b></div>
            </>
          ) : null}
          <div><span>Total</span><b>{formatRupiah(transaction.total)}</b></div>
          {transaction.paymentMethod === 'qris' ? (
            <div><span>Metode</span><b className="qris-receipt-badge">QRIS (Lunas)</b></div>
          ) : (
            <>
              <div><span>Tunai</span><b>{formatRupiah(transaction.cashReceived)}</b></div>
              <div className="change"><span>Kembalian</span><strong>{formatRupiah(transaction.change)}</strong></div>
            </>
          )}
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
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty-state page-empty"><Sparkles /><h3>{title}</h3><p>{text}</p>{action && <div className="empty-action">{action}</div>}</div> }
function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'danger' | 'warning' | 'neutral' }) { return <span className={`status-pill ${tone}`}>{children}</span> }
function SimpleForm({ title, children, submit, close, danger }: { title: string; children: ReactNode; submit: (e: FormEvent<HTMLFormElement>) => void | Promise<void>; close: () => void; danger?: boolean }) { return <Modal title={title} close={close}><form onSubmit={submit} className="stack-form">{children}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Batal</button><button className={`button ${danger ? 'danger' : 'primary'} grow`} type="submit">{danger ? 'Konfirmasi' : 'Simpan'}</button></div></form></Modal> }
function ConfirmDialog({ title, impact, confirmLabel, close, confirm }: { title: string; impact: string; confirmLabel: string; close: () => void; confirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await confirm() } finally { setBusy(false) } }
  return <Modal title={title} close={busy ? undefined : close}><div className="confirm-impact"><CircleAlert size={24} aria-hidden="true" /><div><b>Perhatikan dampaknya</b><p>{impact}</p></div></div><div className="modal-actions"><button className="button secondary" onClick={close} disabled={busy}>Batal</button><button className="button danger grow" onClick={run} disabled={busy}>{busy ? <><span className="spinner" />Memproses…</> : confirmLabel}</button></div></Modal>
}
function BundleFormModal({
  bundle,
  products,
  close,
  save,
}: {
  bundle?: PromoBundle | null
  products: Product[]
  close: () => void
  save: (input: { id?: string; name: string; description?: string; price: number; items: PromoBundleItem[]; active?: boolean }) => Promise<void>
}) {
  const [name, setName] = useState(bundle?.name ?? '')
  const [description, setDescription] = useState(bundle?.description ?? '')
  const [price, setPrice] = useState(bundle?.price ? String(bundle.price) : '')
  const [items, setItems] = useState<PromoBundleItem[]>(
    bundle?.items && bundle.items.length > 0
      ? bundle.items.map((i) => ({ ...i }))
      : products[0]?.variants[0]
      ? [{ productId: products[0].id, variantId: products[0].variants[0].id, quantity: 1 }]
      : []
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const normalTotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const prod = products.find((p) => p.id === item.productId)
      const variant = prod?.variants.find((v) => v.id === item.variantId)
      return sum + (variant?.price ?? 0) * (item.quantity || 1)
    }, 0)
  }, [items, products])

  const bundlePriceNum = Number(price) || 0
  const savings = Math.max(0, normalTotal - bundlePriceNum)
  const savingsPercent = normalTotal > 0 ? Math.round((savings / normalTotal) * 100) : 0

  const addItem = () => {
    if (!products.length) return
    const defaultProd = products[0]
    setItems((old) => [...old, { productId: defaultProd.id, variantId: defaultProd.variants[0]?.id || '', quantity: 1 }])
  }

  const updateItem = (index: number, patch: Partial<PromoBundleItem>) => {
    setItems((old) => {
      const copy = [...old]
      const current = { ...copy[index], ...patch }
      if (patch.productId && patch.productId !== copy[index].productId) {
        const nextProd = products.find((p) => p.id === patch.productId)
        current.variantId = nextProd?.variants[0]?.id || ''
      }
      copy[index] = current
      return copy
    })
  }

  const removeItem = (index: number) => {
    setItems((old) => old.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Nama bundle wajib diisi.'); return }
    if (!items.length) { setError('Tambahkan minimal 1 produk ke dalam bundle.'); return }
    if (bundlePriceNum < 0) { setError('Harga bundle tidak valid.'); return }
    setBusy(true)
    setError('')
    try {
      await save({
        id: bundle?.id,
        name: name.trim(),
        description: description.trim(),
        price: bundlePriceNum,
        items,
        active: bundle?.active ?? true,
      })
      close()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={bundle ? `Edit Promo Bundle` : `Promo Bundle Baru`} close={close} wide>
      <form onSubmit={handleSubmit} className="stack-form bundle-modal-form">
        {error && <Alert>{error}</Alert>}
        <label>
          Nama promo bundle
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Contoh: Paket Cosplay Starter, Bundle Hemat A"
            required
            autoFocus
          />
        </label>
        <label>
          Deskripsi promo
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Contoh: 1 Keychain + 1 Art Print A5 dengan harga spesial"
          />
        </label>

        <div className="bundle-items-section">
          <div className="bundle-items-header">
            <div>
              <span className="bundle-section-title">Produk dalam paket bundle</span>
              <small className="block">Pilih produk & varian yang didapatkan pembeli</small>
            </div>
            <button type="button" className="button secondary small" onClick={addItem}>
              <Plus size={15} /> Tambah produk
            </button>
          </div>

          <div className="bundle-items-rows">
            {items.map((item, idx) => {
              const selectedProduct = products.find((p) => p.id === item.productId)
              const selectedVariant = selectedProduct?.variants.find((v) => v.id === item.variantId)
              const itemPrice = (selectedVariant?.price ?? 0) * (item.quantity || 1)

              return (
                <div key={idx} className="bundle-item-picker-row">
                  <div className="bundle-item-selects">
                    <select
                      value={item.productId}
                      onChange={(e) => updateItem(idx, { productId: e.target.value })}
                    >
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>

                    {selectedProduct && selectedProduct.variants.length > 1 && (
                      <select
                        value={item.variantId}
                        onChange={(e) => updateItem(idx, { variantId: e.target.value })}
                      >
                        {selectedProduct.variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name} ({formatRupiah(v.price)})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="bundle-item-qty">
                    <label className="qty-label">
                      <span>Jml</span>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Math.max(1, Number(e.target.value)) })}
                      />
                    </label>
                  </div>

                  <span className="bundle-item-price-preview">{formatRupiah(itemPrice)}</span>

                  {items.length > 1 && (
                    <button
                      type="button"
                      className="icon-button button-danger-ghost"
                      onClick={() => removeItem(idx)}
                      aria-label="Hapus produk dari bundle"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="bundle-pricing-box">
          <div className="bundle-pricing-row">
            <span>Total harga normal seluruh item:</span>
            <strong>{formatRupiah(normalTotal)}</strong>
          </div>
          <label>
            Harga spesial bundle (Rp)
            <input
              type="number"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Contoh: 50000"
              required
            />
          </label>
          {savings > 0 && (
            <div className="bundle-savings-highlight">
              <Sparkles size={16} />
              <span>
                Pembeli hemat <b>{formatRupiah(savings)}</b> ({savingsPercent}% lebih murah dari harga normal)
              </span>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close} disabled={busy}>
            Batal
          </button>
          <button type="submit" className="button primary grow" disabled={busy || !items.length}>
            {busy ? 'Menyimpan…' : 'Simpan Promo Bundle'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ProductsPage({ data, service, refresh }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void> }) {
  const [viewMode, setViewMode] = useState<'products' | 'bundles'>('products')
  const [kind, setKind] = useState<'product' | 'category' | null>(null)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [bundleModal, setBundleModal] = useState<PromoBundle | 'new' | null>(null)
  const [pending, setPending] = useState<{ type: 'category' | 'product'; id: string; name: string } | null>(null)
  const [pendingBundleDelete, setPendingBundleDelete] = useState<PromoBundle | null>(null)
  const [error, setError] = useState('')
  const [photo, setPhoto] = useState<string>('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [query, setQuery] = useState('')

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.products.filter((p) => {
      const matchCat = selectedCategory === 'all' || p.categoryId === selectedCategory
      const matchQuery = !q || p.name.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q))
      return matchCat && matchQuery
    })
  }, [data.products, selectedCategory, query])

  const filteredBundles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data.bundles ?? []).filter((b) => {
      return !q || b.name.toLowerCase().includes(q) || (b.description && b.description.toLowerCase().includes(q))
    })
  }, [data.bundles, query])

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

  const startEditProduct = (p: Product) => {
    setEditingProduct(p)
    setPhoto(p.image || '')
    setError('')
    setKind('product')
  }

  const submitProduct = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget)
    try {
      await service.saveProduct({
        id: editingProduct ? editingProduct.id : undefined,
        name: String(f.get('name')),
        categoryId: String(f.get('category')),
        description: String(f.get('description')),
        accent: editingProduct?.accent ?? '#b8e5ff',
        image: photo || '',
        price: Number(f.get('price')),
        stock: Number(f.get('stock')),
        variants: [{
          id: editingProduct?.variants[0]?.id,
          name: editingProduct?.variants[0]?.name ?? 'Default',
          price: Number(f.get('price')),
          stock: Number(f.get('stock')),
        }],
      })
      setPhoto('')
      setEditingProduct(null)
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
    try { if (pending.type === 'category') await service.deleteCategory(pending.id); else await service.deleteProduct(pending.id); setPending(null); await refresh() } catch (x) { setPending(null); setError(messageOf(x)) }
  }

  return (
    <section className="admin-page">
      <PageTitle
        eyebrow="Katalog lokal"
        title="Produk & kategori"
        action={
          viewMode === 'products' ? (
            <div className="action-row">
              <button className="button secondary" onClick={() => setKind('category')}><Plus />Kategori</button>
              <button className="button primary" onClick={() => { setEditingProduct(null); setPhoto(''); setKind('product') }}><Plus />Produk baru</button>
            </div>
          ) : (
            <button className="button primary" onClick={() => setBundleModal('new')}>
              <Plus />Bundle baru
            </button>
          )
        }
      />

      <div className="admin-subtabs" role="tablist" aria-label="Pilihan menu produk dan bundle">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'products'}
          className={`admin-subtab ${viewMode === 'products' ? 'active' : ''}`}
          onClick={() => setViewMode('products')}
        >
          <Tag size={16} />
          <span>Katalog Produk ({data.products.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'bundles'}
          className={`admin-subtab ${viewMode === 'bundles' ? 'active' : ''}`}
          onClick={() => setViewMode('bundles')}
        >
          <Gift size={16} />
          <span>Promo Bundle ({data.bundles?.length ?? 0})</span>
        </button>
      </div>

      {error && <Alert>{error}</Alert>}

      {viewMode === 'products' ? (
        <>
          {data.categories.filter((x) => x.id !== 'all').length > 0 && (
            <div className="category-manager-bar">
              <span className="category-manager-label">Kelola kategori:</span>
              <div className="category-manager">
                {data.categories.filter((x) => x.id !== 'all').map((c) => (
                  <span key={c.id} className={selectedCategory === c.id ? 'active' : ''}>
                    <button
                      type="button"
                      className="category-filter-chip-btn"
                      onClick={() => setSelectedCategory(selectedCategory === c.id ? 'all' : c.id)}
                      title={`Klik untuk filter produk kategori ${c.name}`}
                    >
                      {c.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Hapus kategori ${c.name}`}
                      onClick={() => setPending({ type: 'category', id: c.id, name: c.name })}
                    >
                      <X size={15} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="table-filter-bar">
            <div className="category-pill-row" role="tablist" aria-label="Filter kategori produk">
              {data.categories.map((c) => {
                const count = c.id === 'all'
                  ? data.products.length
                  : data.products.filter((p) => p.categoryId === c.id).length
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={selectedCategory === c.id}
                    className={`category-pill ${selectedCategory === c.id ? 'active' : ''}`}
                    onClick={() => setSelectedCategory(c.id)}
                  >
                    <span>{c.name}</span>
                    <span className="pill-count">{count}</span>
                  </button>
                )
              })}
            </div>
            <div className="table-filter-search-row">
              <label className="search-box">
                <Search size={18} />
                <span className="sr-only">Cari produk</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Cari nama atau deskripsi produk…"
                />
              </label>
              {(selectedCategory !== 'all' || query.trim() !== '') && (
                <button
                  type="button"
                  className="button ghost small reset-filter-btn"
                  onClick={() => { setSelectedCategory('all'); setQuery('') }}
                >
                  <X size={15} /> Reset filter ({filteredProducts.length}/{data.products.length})
                </button>
              )}
            </div>
          </div>

          <div className="table-card">
            <table>
              <thead><tr><th>Produk</th><th>Kategori</th><th>Harga</th><th>Stok</th><th>Aksi</th></tr></thead>
              <tbody>
                {!filteredProducts.length ? (
                  <tr>
                    <td colSpan={5} className="empty-table-cell">
                      <div className="empty-filter-state">
                        <Sparkles size={28} />
                        <p>Tidak ada produk yang cocok dengan filter kategori atau pencarian.</p>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => { setSelectedCategory('all'); setQuery('') }}
                        >
                          Tampilkan semua produk
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((p) => {
                    const totalStock = p.variants.reduce((s, v) => s + v.stock, 0)
                    const categoryObj = data.categories.find((c) => c.id === p.categoryId)
                    return (
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
                        <td>
                          {categoryObj ? (
                            <button
                              type="button"
                              className="category-link-btn"
                              aria-label={`Filter kategori ${categoryObj.name}`}
                              onClick={() => setSelectedCategory(p.categoryId)}
                              title={`Klik untuk filter kategori ${categoryObj.name}`}
                            >
                              <Tag size={13} />
                              <span>{categoryObj.name}</span>
                            </button>
                          ) : '—'}
                        </td>
                        <td>{formatRupiah(Math.min(...p.variants.map((v) => v.price)))}</td>
                        <td>
                          {totalStock === 0 ? (
                            <span className="stock-pill out">Habis</span>
                          ) : totalStock <= 3 ? (
                            <span className="stock-pill low"><AlertTriangle size={13} /> Sisa {totalStock}</span>
                          ) : (
                            <span className="stock-pill ok">{totalStock}</span>
                          )}
                        </td>
                        <td>
                          <div className="action-row">
                            <button className="button secondary small" onClick={() => startEditProduct(p)} aria-label={`Edit ${p.name}`}>
                              <Pencil size={15} />Edit
                            </button>
                            <button className="button ghost small button-danger-ghost" onClick={() => setPending({ type: 'product', id: p.id, name: p.name })} aria-label={`Hapus ${p.name}`}>
                              <Trash2 size={16} />Hapus
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="bundle-manager-section">
          <div className="bundle-search-bar">
            <label className="search-box">
              <Search size={18} />
              <span className="sr-only">Cari promo bundle</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cari promo bundle…"
              />
            </label>
            {query.trim() !== '' && (
              <button
                type="button"
                className="button ghost small"
                onClick={() => setQuery('')}
              >
                <X size={15} /> Reset ({filteredBundles.length}/{data.bundles?.length ?? 0})
              </button>
            )}
          </div>

          <div className="bundle-management-grid">
            {!filteredBundles.length ? (
              <Empty
                title={query ? 'Promo bundle tidak ditemukan' : 'Belum ada promo bundle'}
                text={
                  query
                    ? `Tidak ada promo bundle dengan kata kunci "${query}".`
                    : 'Buat paket bundle hemat produk (misal: Beli A + B hemat Rp 15.000) untuk menarik minat pembeli di event.'
                }
                action={
                  !query ? (
                    <button type="button" className="button primary" onClick={() => setBundleModal('new')}>
                      <Plus size={16} /> Buat Promo Bundle
                    </button>
                  ) : (
                    <button type="button" className="button secondary small" onClick={() => setQuery('')}>
                      Tampilkan semua bundle
                    </button>
                  )
                }
              />
            ) : (
              filteredBundles.map((bundle) => {
                let normalTotal = 0
                let maxBundleStock = Infinity
                const resolvedItems = bundle.items.map((item) => {
                  const product = data.products.find((p) => p.id === item.productId)
                  const variant = product?.variants.find((v) => v.id === item.variantId)
                  const price = variant?.price ?? 0
                  const stock = variant?.stock ?? 0
                  normalTotal += price * item.quantity
                  maxBundleStock = Math.min(maxBundleStock, Math.floor(stock / item.quantity))
                  return { item, product, variant, price, stock }
                })
                if (maxBundleStock === Infinity) maxBundleStock = 0
                const savings = Math.max(0, normalTotal - bundle.price)
                const savingsPercent = normalTotal > 0 ? Math.round((savings / normalTotal) * 100) : 0

                return (
                  <article key={bundle.id} className={`bundle-admin-card ${!bundle.active ? 'bundle-inactive' : ''}`}>
                    <div className="bundle-admin-head">
                      <div className="bundle-admin-title-group">
                        <div className="bundle-icon-wrap">
                          <Gift size={22} />
                        </div>
                        <div>
                          <div className="bundle-name-row">
                            <h3>{bundle.name}</h3>
                            <StatusPill tone={bundle.active ? 'success' : 'neutral'}>
                              {bundle.active ? 'Aktif di Kasir' : 'Nonaktif'}
                            </StatusPill>
                          </div>
                          {bundle.description && <p className="bundle-admin-desc">{bundle.description}</p>}
                        </div>
                      </div>
                    </div>

                    <div className="bundle-admin-items-list">
                      <span className="bundle-items-sublabel">Isi Paket:</span>
                      <div className="bundle-items-tags">
                        {resolvedItems.map(({ item, product, variant, price }) => (
                          <span key={item.variantId} className="bundle-admin-tag">
                            <b>{item.quantity}×</b> {product?.name || 'Item'} {variant?.name && variant.name !== 'Default' ? `(${variant.name})` : ''} · <small>{formatRupiah(price)}</small>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="bundle-admin-pricing-banner">
                      <div className="pricing-left">
                        <span className="bundle-price-big">{formatRupiah(bundle.price)}</span>
                        {normalTotal > bundle.price && (
                          <small className="normal-strikethrough">Normal: <s>{formatRupiah(normalTotal)}</s></small>
                        )}
                      </div>
                      {savings > 0 && (
                        <div className="savings-badge-pill">
                          <Sparkles size={14} /> Hemat {formatRupiah(savings)} ({savingsPercent}%)
                        </div>
                      )}
                    </div>

                    <div className="bundle-admin-stock-info">
                      {maxBundleStock > 0 ? (
                        <span className="stock-pill ok">Kapasitas stok: {maxBundleStock} paket</span>
                      ) : (
                        <span className="stock-pill out">Stok bahan habis</span>
                      )}
                    </div>

                    <div className="bundle-admin-actions">
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={async () => {
                          await service.toggleBundleActive(bundle.id)
                          await refresh()
                        }}
                      >
                        {bundle.active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setBundleModal(bundle)}
                        aria-label={`Edit ${bundle.name}`}
                      >
                        <Pencil size={15} /> Edit
                      </button>
                      <button
                        type="button"
                        className="button ghost small button-danger-ghost"
                        onClick={() => setPendingBundleDelete(bundle)}
                        aria-label={`Hapus ${bundle.name}`}
                      >
                        <Trash2 size={15} /> Hapus
                      </button>
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </div>
      )}

      {kind === 'product' && (
        <SimpleForm title={editingProduct ? `Edit ${editingProduct.name}` : 'Produk baru'} close={() => { setKind(null); setPhoto(''); setEditingProduct(null) }} submit={submitProduct}>
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
          <label>Nama produk<input name="name" autoFocus defaultValue={editingProduct?.name ?? ''} required placeholder="Contoh: Acrylic Keychain" /></label>
          <label>Kategori<select name="category" defaultValue={editingProduct?.categoryId ?? data.categories.filter((x) => x.id !== 'all')[0]?.id} required>{data.categories.filter((x) => x.id !== 'all').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Deskripsi<input name="description" defaultValue={editingProduct?.description ?? ''} placeholder="Contoh: Art paper 260 gsm, laminasi doff" /></label>
          <div className="form-grid form-grid-2">
            <label>Harga (Rp)<input name="price" type="number" min="0" defaultValue={editingProduct?.variants[0]?.price ?? ''} placeholder="25000" required /></label>
            <label>{editingProduct ? 'Jumlah stok' : 'Stok awal'}<input name="stock" type="number" min="0" defaultValue={editingProduct ? editingProduct.variants.reduce((s, v) => s + v.stock, 0) : ''} placeholder="10" required /></label>
          </div>
        </SimpleForm>
      )}

      {kind === 'category' && <SimpleForm title="Kategori baru" close={() => setKind(null)} submit={submitCategory}><label>Nama kategori<input name="name" autoFocus required /></label></SimpleForm>}

      {bundleModal && (
        <BundleFormModal
          bundle={bundleModal === 'new' ? null : bundleModal}
          products={data.products}
          close={() => setBundleModal(null)}
          save={async (input) => {
            await service.saveBundle(input)
            await refresh()
          }}
        />
      )}

      {pending && <ConfirmDialog title={pending.type === 'category' ? `Hapus kategori ${pending.name}?` : `Hapus produk ${pending.name}?`} impact={pending.type === 'category' ? 'Kategori akan dihapus permanen. Kategori yang masih dipakai produk aktif tidak dapat dihapus.' : 'Produk akan dihapus dari katalog dan inventori. Catatan transaksi lama tetap aman tersimpan.'} confirmLabel={pending.type === 'category' ? 'Hapus kategori' : 'Hapus produk'} close={() => setPending(null)} confirm={confirmPending} />}

      {pendingBundleDelete && (
        <ConfirmDialog
          title={`Hapus promo bundle ${pendingBundleDelete.name}?`}
          impact="Promo bundle ini akan dihapus dari sistem dan tidak muncul lagi di kasir. Riwayat transaksi lama tetap aman tersimpan."
          confirmLabel="Hapus bundle"
          close={() => setPendingBundleDelete(null)}
          confirm={async () => {
            await service.deleteBundle(pendingBundleDelete.id)
            setPendingBundleDelete(null)
            await refresh()
          }}
        />
      )}
    </section>
  )
}
function StockPage({ data, service, refresh }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void> }) {
  const [variant, setVariant] = useState<{ product: Product; id: string } | null>(null)
  const [error, setError] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [query, setQuery] = useState('')

  const variants = data.products.flatMap((p) => p.variants.map((v) => ({ ...v, product: p })))
  const lowStockCount = variants.filter((v) => v.stock > 0 && v.stock <= 3).length

  const filteredVariants = useMemo(() => {
    const q = query.trim().toLowerCase()
    return variants.filter((v) => {
      const matchCat = selectedCategory === 'all' || v.product.categoryId === selectedCategory
      const matchQuery = !q || v.product.name.toLowerCase().includes(q) || (v.name && v.name.toLowerCase().includes(q)) || (v.sku && v.sku.toLowerCase().includes(q))
      return matchCat && matchQuery
    })
  }, [variants, selectedCategory, query])

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
      {lowStockCount > 0 && (
        <div className="low-stock-banner" role="status">
          <AlertTriangle size={19} />
          <span><b>Peringatan Stok Menipis:</b> Ada {lowStockCount} varian dagangan dengan sisa stok ≤ 3. Segera restock!</span>
        </div>
      )}
      {error && <Alert>{error}</Alert>}

      <div className="table-filter-bar">
        <div className="category-pill-row" role="tablist" aria-label="Filter kategori stok">
          {data.categories.map((c) => {
            const count = c.id === 'all'
              ? variants.length
              : variants.filter((v) => v.product.categoryId === c.id).length
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={selectedCategory === c.id}
                className={`category-pill ${selectedCategory === c.id ? 'active' : ''}`}
                onClick={() => setSelectedCategory(c.id)}
              >
                <span>{c.name}</span>
                <span className="pill-count">{count}</span>
              </button>
            )
          })}
        </div>
        <div className="table-filter-search-row">
          <label className="search-box">
            <Search size={18} />
            <span className="sr-only">Cari stok</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari produk, varian, atau SKU…"
            />
          </label>
          {(selectedCategory !== 'all' || query.trim() !== '') && (
            <button
              type="button"
              className="button ghost small reset-filter-btn"
              onClick={() => { setSelectedCategory('all'); setQuery('') }}
            >
              <X size={15} /> Reset filter ({filteredVariants.length}/{variants.length})
            </button>
          )}
        </div>
      </div>

      <div className="stock-grid">
        <div className="table-card">
          <table>
            <thead><tr><th>Produk</th><th>Kategori</th><th>SKU</th><th>Stok</th><th>Aksi</th></tr></thead>
            <tbody>
              {!filteredVariants.length ? (
                <tr>
                  <td colSpan={5} className="empty-table-cell">
                    <div className="empty-filter-state">
                      <Sparkles size={28} />
                      <p>Tidak ada varian stok yang cocok dengan filter kategori atau pencarian.</p>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => { setSelectedCategory('all'); setQuery('') }}
                      >
                        Tampilkan semua stok
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredVariants.map((v) => {
                  const categoryObj = data.categories.find((c) => c.id === v.product.categoryId)
                  return (
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
                      <td>
                        {categoryObj ? (
                          <button
                            type="button"
                            className="category-link-btn"
                            aria-label={`Filter kategori ${categoryObj.name}`}
                            onClick={() => setSelectedCategory(v.product.categoryId)}
                            title={`Klik untuk filter kategori ${categoryObj.name}`}
                          >
                            <Tag size={13} />
                            <span>{categoryObj.name}</span>
                          </button>
                        ) : '—'}
                      </td>
                      <td><code>{v.sku || '—'}</code></td>
                      <td className="number-cell">
                        {v.stock === 0 ? (
                          <span className="stock-pill out">Habis</span>
                        ) : v.stock <= 3 ? (
                          <span className="stock-pill low"><AlertTriangle size={13} /> Sisa {v.stock}</span>
                        ) : (
                          <span className="stock-pill ok">{v.stock}</span>
                        )}
                      </td>
                      <td><button className="button secondary small" onClick={() => setVariant({ product: v.product, id: v.id })}>Sesuaikan</button></td>
                    </tr>
                  )
                })
              )}
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
function EventsPage({ data, service, refresh, select }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void>; select: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<BoothEvent | null>(null)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    try {
      const event = await service.saveEvent({
        name: String(f.get('name')),
        venue: String(f.get('venue')),
        dateLabel: String(f.get('date')),
      })
      await service.setActiveEvent(event.id)
      setOpen(false)
      select(event.id)
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      const nextActiveId = await service.deleteEvent(pendingDelete.id)
      if (nextActiveId) {
        select(nextActiveId)
      } else {
        const remaining = data.events.filter((e) => e.id !== pendingDelete.id)
        if (remaining[0]) select(remaining[0].id)
      }
      setPendingDelete(null)
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="admin-page">
      <PageTitle
        eyebrow="Periode penjualan"
        title="Pengelolaan event"
        action={
          <button className="button primary" onClick={() => setOpen(true)}>
            <Plus />Event baru
          </button>
        }
      />
      {error && <Alert>{error}</Alert>}
      <div className="event-grid">
        {data.events.map((x) => {
          const isOnlyEvent = data.events.length <= 1
          return (
            <article className={`event-card ${x.active ? 'active' : ''}`} key={x.id}>
              <div className="event-card-head">
                <CalendarDays size={24} className="event-card-icon" />
                {x.active && <StatusPill tone="success">Sedang aktif</StatusPill>}
              </div>
              <h2>{x.name}</h2>
              <p>{x.venue || 'Lokasi belum diisi'} · {x.dateLabel}</p>
              <div className="event-card-footer">
                <div className="event-card-status">
                  {!x.active && (
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={async () => {
                        await service.setActiveEvent(x.id)
                        select(x.id)
                        await refresh()
                      }}
                    >
                      Aktifkan
                    </button>
                  )}
                </div>
                <div className="event-card-actions">
                  <button
                    type="button"
                    className="button ghost small button-danger-ghost"
                    disabled={isOnlyEvent}
                    onClick={() => setPendingDelete(x)}
                    aria-label={`Hapus event ${x.name}`}
                    title={isOnlyEvent ? 'Minimal harus ada 1 event tersisa' : `Hapus event ${x.name}`}
                  >
                    <Trash2 size={16} />
                    <span>Hapus</span>
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>
      {open && (
        <SimpleForm title="Event baru" close={() => setOpen(false)} submit={submit}>
          <label>Nama event<input name="name" autoFocus required /></label>
          <label>Lokasi<input name="venue" placeholder="Contoh: ICE BSD Hall 10" /></label>
          <label>Tanggal / label<input name="date" placeholder="Contoh: 16-17 Okt 2026" required /></label>
        </SimpleForm>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Hapus event ${pendingDelete.name}?`}
          impact={`Seluruh data transaksi (${data.transactions.filter((t) => t.eventId === pendingDelete.id).length} transaksi) dan laporan penjualan pada event ${pendingDelete.name} akan dihapus secara permanen. Stok produk barang tidak akan terpengaruh.`}
          confirmLabel="Hapus event"
          close={() => setPendingDelete(null)}
          confirm={confirmDelete}
        />
      )}
    </section>
  )
}
function ReportsPage({ data, service, eventId }: { data: BootstrapData; service: LocalPosService; eventId: string }) {
  const [tab, setTab] = useState<'single' | 'comparison'>('single')
  const [report, setReport] = useState<EventReport | null>(null)
  const [comparison, setComparison] = useState<EventComparisonReport | null>(null)
  const [compLoading, setCompLoading] = useState(false)

  useEffect(() => {
    if (eventId) service.getEventReport(eventId).then(setReport)
  }, [service, eventId, data.transactions])

  useEffect(() => {
    if (tab === 'comparison') {
      setCompLoading(true)
      service.getEventComparison().then((res) => {
        setComparison(res)
        setCompLoading(false)
      })
    }
  }, [service, tab, data.transactions, data.events])

  const event = data.events.find((x) => x.id === eventId)

  return (
    <section className="admin-page">
      <PageTitle
        eyebrow={tab === 'single' ? (event?.name ?? 'Event') : 'Analisis Performa'}
        title={tab === 'single' ? 'Laporan event' : 'Perbandingan Antar Event'}
      />

      <div className="admin-subtabs" role="tablist" aria-label="Pilihan tampilan laporan">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'single'}
          className={`admin-subtab ${tab === 'single' ? 'active' : ''}`}
          onClick={() => setTab('single')}
        >
          <BarChart3 size={16} />
          <span>Laporan Event Aktif</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'comparison'}
          className={`admin-subtab ${tab === 'comparison' ? 'active' : ''}`}
          onClick={() => setTab('comparison')}
        >
          <TrendingUp size={16} />
          <span>Perbandingan Antar Event ({data.events.length})</span>
        </button>
      </div>

      {tab === 'single' ? (
        !report ? (
          <Empty title="Menyiapkan laporan" text="Menghitung dari transaksi tersimpan…" />
        ) : (
          <>
            <div className="metric-grid metric-grid--5">
              <Metric icon={<CircleDollarSign />} label="Total Omzet" value={formatRupiah(report.revenue)} hint={`${report.transactionCount} transaksi tersimpan`} />
              <Metric icon={<Banknote />} label="Omzet Tunai" value={formatRupiah(report.cashRevenue ?? 0)} hint="Pembayaran fisik kasir" />
              <Metric icon={<QrCode />} label="Omzet QRIS" value={formatRupiah(report.qrisRevenue ?? 0)} hint="Pembayaran nontunai QRIS" />
              <Metric icon={<ReceiptText />} label="Rata-rata Nota" value={formatRupiah(report.averageTicket)} hint={`${report.voidCount} transaksi batal`} />
              <Metric icon={<Package />} label="Barang Terjual" value={String(report.itemsSold)} hint="Item berhasil terjual" />
            </div>
            <div className="report-grid">
              <article className="chart-card">
                <div className="card-heading"><h2>Penjualan per jam</h2></div>
                <div className="bar-chart">
                  {report.byHour.map((x) => (
                    <div className="bar-wrap" key={x.hour}>
                      <span className="bar" style={{ height: `${report.revenue ? Math.max(5, (x.revenue / report.revenue) * 100) : 5}%` }} />
                      <small>{x.hour}</small>
                    </div>
                  ))}
                </div>
              </article>
              <article className="ranking-card">
                <div className="card-heading"><h2>Produk terlaris</h2></div>
                {report.topProducts.map((x, i) => (
                  <div className="rank-row" key={x.productId}>
                    <span>{i + 1}</span>
                    <div><b>{x.productName}</b><small>{formatRupiah(x.revenue)}</small></div>
                    <strong>{x.quantity}</strong>
                  </div>
                ))}
              </article>
            </div>
          </>
        )
      ) : compLoading || !comparison ? (
        <Empty title="Menghitung perbandingan" text="Menganalisis performa seluruh event tersimpan…" />
      ) : (
        <div className="comparison-content">
          <div className="metric-grid metric-grid--4">
            <Metric
              icon={<Trophy />}
              label="Event Terlaris (Omzet)"
              value={comparison.summary.bestRevenueEvent ? formatRupiah(comparison.summary.bestRevenueEvent.revenue) : '—'}
              hint={comparison.summary.bestRevenueEvent ? comparison.summary.bestRevenueEvent.name : 'Belum ada transaksi'}
            />
            <Metric
              icon={<Zap />}
              label="Transaksi Terbanyak"
              value={comparison.summary.bestTransactionsEvent ? `${comparison.summary.bestTransactionsEvent.count} TRX` : '—'}
              hint={comparison.summary.bestTransactionsEvent ? comparison.summary.bestTransactionsEvent.name : 'Belum ada transaksi'}
            />
            <Metric
              icon={<Target />}
              label="Rata-rata Belanja Tertinggi"
              value={comparison.summary.highestTicketEvent ? formatRupiah(comparison.summary.highestTicketEvent.averageTicket) : '—'}
              hint={comparison.summary.highestTicketEvent ? comparison.summary.highestTicketEvent.name : 'Belum ada transaksi'}
            />
            <Metric
              icon={<CircleDollarSign />}
              label="Total Seluruh Event"
              value={formatRupiah(comparison.summary.totalRevenueAllEvents)}
              hint={`${comparison.summary.totalTransactionsAllEvents} transaksi dari ${comparison.events.length} event`}
            />
          </div>

          <div className="report-grid comparison-charts-grid">
            <article className="chart-card comparison-bar-card">
              <div className="card-heading">
                <div>
                  <h2>Perbandingan Omzet Antar Event</h2>
                  <p>Membandingkan total omzet dan porsi Tunai vs QRIS</p>
                </div>
              </div>
              <div className="comparison-bars-container">
                {comparison.events.map((item) => {
                  const maxRev = Math.max(...comparison.events.map((e) => e.report.revenue), 1)
                  const percentWidth = Math.max(4, Math.round((item.report.revenue / maxRev) * 100))
                  const cashRatio = item.report.revenue > 0 ? (item.report.cashRevenue / item.report.revenue) * 100 : 50
                  const qrisRatio = item.report.revenue > 0 ? (item.report.qrisRevenue / item.report.revenue) * 100 : 50

                  return (
                    <div key={item.event.id} className="event-comp-bar-row">
                      <div className="event-comp-bar-header">
                        <div className="event-comp-name-group">
                          <b>{item.event.name}</b>
                          {item.event.id === eventId && <span className="active-tag">Event Aktif</span>}
                          <small>{item.event.venue ? `${item.event.venue} · ` : ''}{item.event.dateLabel}</small>
                        </div>
                        <div className="event-comp-revenue-group">
                          <strong>{formatRupiah(item.report.revenue)}</strong>
                          {item.growthPercent !== undefined && (
                            <span className={`growth-tag ${item.growthPercent >= 0 ? 'growth-positive' : 'growth-negative'}`}>
                              {item.growthPercent >= 0 ? `+${item.growthPercent}%` : `${item.growthPercent}%`}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="event-comp-bar-track">
                        <div className="event-comp-bar-fill" style={{ width: `${percentWidth}%` }}>
                          <span className="split-cash" style={{ width: `${cashRatio}%` }} title={`Tunai: ${formatRupiah(item.report.cashRevenue)}`} />
                          <span className="split-qris" style={{ width: `${qrisRatio}%` }} title={`QRIS: ${formatRupiah(item.report.qrisRevenue)}`} />
                        </div>
                      </div>

                      <div className="event-comp-bar-footer">
                        <small>Tunai: {formatRupiah(item.report.cashRevenue)} ({Math.round(cashRatio)}%) · QRIS: {formatRupiah(item.report.qrisRevenue)} ({Math.round(qrisRatio)}%)</small>
                        <small>{item.report.transactionCount} transaksi</small>
                      </div>
                    </div>
                  )
                })}
              </div>
            </article>

            <article className="ranking-card comparison-top-products-card">
              <div className="card-heading">
                <div>
                  <h2>Produk Terlaris Lintas Event</h2>
                  <p>Top kontributor omzet dari semua event</p>
                </div>
              </div>
              <div className="overall-top-list">
                {!comparison.summary.overallTopProducts.length ? (
                  <p className="empty-subtext">Belum ada data penjualan.</p>
                ) : (
                  comparison.summary.overallTopProducts.map((p, i) => (
                    <div className="rank-row" key={p.productId}>
                      <span className={i === 0 ? 'rank-crown' : ''}>{i + 1}</span>
                      <div>
                        <b>{p.productName}</b>
                        <small>Total omzet {formatRupiah(p.revenue)}</small>
                      </div>
                      <div className="rank-qty-block">
                        <strong>{p.quantity}</strong>
                        <small>terjual</small>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </article>
          </div>

          <div className="table-card comparison-table-card">
            <div className="card-heading">
              <div>
                <h2>Tabel Evaluasi Komparasi Seluruh Event</h2>
                <p>Ringkasan metrik lengkap untuk evaluasi performa booth</p>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Lokasi & Tanggal</th>
                  <th>Total Omzet</th>
                  <th>Tunai</th>
                  <th>QRIS</th>
                  <th>Transaksi</th>
                  <th>Barang Terjual</th>
                  <th>Rata-rata Nota</th>
                  <th>Produk Terlaris #1</th>
                </tr>
              </thead>
              <tbody>
                {comparison.events.map(({ event: ev, report: rep, growthPercent }) => {
                  const topProduct = rep.topProducts[0]
                  return (
                    <tr key={ev.id}>
                      <td>
                        <div className="table-event-cell">
                          <b>{ev.name}</b>
                          {ev.id === eventId && <span className="active-tag">Aktif</span>}
                        </div>
                      </td>
                      <td>
                        <div>{ev.venue || '—'}</div>
                        <small className="block">{ev.dateLabel}</small>
                      </td>
                      <td>
                        <div className="table-revenue-cell">
                          <b>{formatRupiah(rep.revenue)}</b>
                          {growthPercent !== undefined && (
                            <span className={`growth-tag small ${growthPercent >= 0 ? 'growth-positive' : 'growth-negative'}`}>
                              {growthPercent >= 0 ? `+${growthPercent}%` : `${growthPercent}%`}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>{formatRupiah(rep.cashRevenue)}</td>
                      <td>{formatRupiah(rep.qrisRevenue)}</td>
                      <td>
                        <b>{rep.transactionCount}</b>
                        {rep.voidCount > 0 && <small className="block void-reason">({rep.voidCount} batal)</small>}
                      </td>
                      <td>{rep.itemsSold} item</td>
                      <td>{formatRupiah(rep.averageTicket)}</td>
                      <td>
                        {topProduct ? (
                          <div>
                            <b>{topProduct.productName}</b>
                            <small className="block">{topProduct.quantity} terjual · {formatRupiah(topProduct.revenue)}</small>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) { return <article className="metric-card"><span>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{hint}</small></div></article> }
function MoreMenu({ navigate }: { navigate: (screen: Screen) => void }) { return <section className="admin-page mobile-more"><PageTitle eyebrow="Menu lainnya" title="Kelola booth" /><div className="more-grid">{NAV.slice(3).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)}><Icon size={23} /><span>{label}</span></button>)}</div></section> }
function TransactionsPage({ data, service, refresh, receipt }: { data: BootstrapData; service: LocalPosService; refresh: () => Promise<void>; receipt: (t: Transaction) => void }) {
  const [target, setTarget] = useState<Transaction | null>(null); const [error, setError] = useState('')
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!target) return; const f = new FormData(e.currentTarget); try { await service.voidTransaction(target.id, String(f.get('reason'))); setTarget(null); await refresh() } catch (x) { setError(messageOf(x)) } }
  return (
    <section className="admin-page">
      <PageTitle eyebrow="Jejak penjualan" title="Riwayat transaksi" />
      {error && <Alert>{error}</Alert>}
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Nomor</th>
              <th>Waktu</th>
              <th>Metode</th>
              <th>Kasir</th>
              <th>Total</th>
              <th>Status</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {data.transactions.map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.number}</b>
                  {t.voidReason && <small className="block void-reason">Alasan: {t.voidReason}</small>}
                </td>
                <td>{new Date(t.createdAt).toLocaleString('id-ID')}</td>
                <td>
                  <StatusPill tone={t.paymentMethod === 'qris' ? 'warning' : 'neutral'}>
                    {t.paymentMethod === 'qris' ? 'QRIS' : 'Tunai'}
                  </StatusPill>
                </td>
                <td>{t.cashierName}</td>
                <td>{formatRupiah(t.total)}</td>
                <td><StatusPill tone={t.status === 'void' ? 'danger' : 'success'}>{t.status === 'void' ? 'Batal' : 'Selesai'}</StatusPill></td>
                <td>
                  <div className="action-row">
                    <button className="button ghost small" onClick={() => receipt(t)}><ReceiptText size={17} />Struk</button>
                    {t.status !== 'void' && <button className="button danger small" onClick={() => setTarget(t)}>Batalkan</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {target && (
        <SimpleForm title={`Batalkan ${target.number}?`} danger close={() => setTarget(null)} submit={submit}>
          <div className="confirm-impact">
            <CircleAlert size={24} aria-hidden="true" />
            <div>
              <b>Transaksi akan dibatalkan</b>
              <p>Stok seluruh item dikembalikan. Transaksi tetap ada di riwayat dengan alasan pembatalan dan tidak dihitung sebagai omzet.</p>
            </div>
          </div>
          <label>Alasan pembatalan<input name="reason" autoFocus required minLength={3} placeholder="Contoh: salah pilih varian" /></label>
        </SimpleForm>
      )}
    </section>
  )
}
function SettingsPage({ service, settings, setSettings }: { service: LocalPosService; settings: ShopSettings; setSettings: (s: ShopSettings) => void }) {
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [restore, setRestore] = useState(false)
  const [qrisPhoto, setQrisPhoto] = useState(settings.qrisImage || '')

  useEffect(() => {
    setQrisPhoto(settings.qrisImage || '')
  }, [settings.qrisImage])

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    try {
      const next = await service.saveSettings({
        shopName: String(f.get('shop')),
        defaultCashier: String(f.get('cashier')),
        footer: String(f.get('footer')),
        receiptPrefix: String(f.get('prefix')),
      })
      setSettings(next)
      setNotice('Pengaturan disimpan di perangkat.')
      setError('')
    } catch (x) {
      setError(messageOf(x))
    }
  }

  const handleQrisSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('File QRIS harus berupa gambar (JPG, PNG, WebP).')
      return
    }
    try {
      const optimized = await optimizeImageFile(file, 800)
      setQrisPhoto(optimized)
      const next = await service.saveSettings({ qrisImage: optimized })
      setSettings(next)
      setNotice('Foto QRIS berhasil disimpan di perangkat.')
      setError('')
    } catch {
      setError('Gagal membaca gambar QRIS. Coba gambar lain.')
    }
  }

  const removeQris = async () => {
    try {
      setQrisPhoto('')
      const next = await service.saveSettings({ qrisImage: '' })
      setSettings(next)
      setNotice('Foto QRIS dihapus.')
      setError('')
    } catch (x) {
      setError(messageOf(x))
    }
  }

  const backup = async () => {
    try {
      const content = JSON.stringify(await service.exportBackup(), null, 2)
      const result = await saveToDevice(backupFileName(), content)
      setNotice(result.saved ? `Backup disimpan: ${result.location}` : 'Penyimpanan dibatalkan.')
      setError('')
    } catch (x) {
      setError(messageOf(x))
    }
  }

  const doRestore = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const file = new FormData(e.currentTarget).get('file')
    try {
      if (!(file instanceof File) || !file.size) throw new Error('Pilih file backup JSON.')
      await service.restoreBackup(await file.text())
      setRestore(false)
      window.location.reload()
    } catch (x) {
      setError(messageOf(x))
    }
  }

  return (
    <section className="admin-page">
      <PageTitle eyebrow="Preferensi booth" title="Pengaturan" />
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="settings-grid">
        <form className="settings-card stack-form" onSubmit={save}>
          <div className="card-heading">
            <div>
              <h2>Identitas booth</h2>
              <p>Tampil di aplikasi dan struk</p>
            </div>
            <Sparkles />
          </div>
          <label>Nama booth<input name="shop" defaultValue={settings.shopName} required /></label>
          <label>Nama kasir bawaan<input name="cashier" defaultValue={settings.defaultCashier} required /></label>
          <label>Pesan struk<input name="footer" defaultValue={settings.footer} required /></label>
          <label>Prefix struk<input name="prefix" defaultValue={settings.receiptPrefix} required /></label>
          <button className="button primary" type="submit">Simpan pengaturan</button>
        </form>

        <article className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Kode QRIS Booth</h2>
              <p>Tampil ke pembeli saat checkout QRIS</p>
            </div>
            <QrCode />
          </div>
          <div className="qris-settings-body">
            {qrisPhoto ? (
              <div className="qris-preview-card">
                <img src={qrisPhoto} alt="QRIS booth" className="qris-preview-img" />
                <div className="qris-preview-info">
                  <b>QRIS Booth Aktif</b>
                  <p>Kode QRIS siap ditampilkan ke pembeli saat memilih metode pembayaran QRIS.</p>
                  <div className="action-row">
                    <label className="button secondary small change-photo-btn">
                      <Upload size={15} /> Ganti foto
                      <input type="file" accept="image/*" className="sr-only" onChange={handleQrisSelect} />
                    </label>
                    <button type="button" className="button ghost small button-danger-ghost" onClick={removeQris}>
                      <Trash2 size={15} /> Hapus
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <label className="photo-dropzone">
                <QrCode size={36} />
                <span>Unggah foto kode QRIS booth</span>
                <small>Foto atau barcode QRIS (GoPay, OVO, Dana, BCA, dll). Maks. 5MB.</small>
                <input type="file" accept="image/*" className="sr-only" onChange={handleQrisSelect} />
              </label>
            )}
          </div>
        </article>

        <article className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Backup lokal</h2>
              <p>Simpan di luar penyimpanan aplikasi</p>
            </div>
            <Download />
          </div>
          <p>Ekspor backup secara rutin ke Dokumen agar data tetap bisa dipulihkan bila aplikasi dihapus atau HP bermasalah.</p>
          <div className="action-row">
            <button className="button primary" onClick={backup}><Download size={18} />Ekspor backup</button>
            <button className="button secondary" onClick={() => setRestore(true)}><FileUp size={18} />Restore</button>
          </div>
        </article>

        <article className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Mode offline</h2>
              <p>Tidak ada server yang diperlukan</p>
            </div>
            <WifiOff />
          </div>
          <p>Produk, event, transaksi, stok, dan laporan disimpan langsung di HP ini.</p>
        </article>
      </div>
      {restore && (
        <SimpleForm title="Restore backup?" danger close={() => setRestore(false)} submit={doRestore}>
          <div className="confirm-impact">
            <CircleAlert size={24} aria-hidden="true" />
            <div>
              <b>Seluruh data aktif akan diganti</b>
              <p>Produk, stok, event, transaksi, dan pengaturan saat ini akan ditimpa oleh isi file. Ekspor backup sekarang terlebih dahulu bila data lama masih dibutuhkan.</p>
            </div>
          </div>
          <label>File backup JSON<input name="file" type="file" accept="application/json,.json" required autoFocus /></label>
        </SimpleForm>
      )}
    </section>
  )
}

export default function App({ service = posService }: { service?: LocalPosService }) {
  const [boot, setBoot] = useState<'loading' | 'app' | 'error'>('loading')
  const [bootError, setBootError] = useState('')
  const [data, setData] = useState<BootstrapData | null>(null)
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [screen, setScreen] = useState<Screen>('pos')
  const [eventId, setEventId] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [appliedPromo, setAppliedPromo] = useState<{ id: string; name: string; discount: number } | null>(null)
  const [checkout, setCheckout] = useState(false)
  const [receipt, setReceipt] = useState<Transaction | null>(null)
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        await service.ready()
        const [next, nextSettings] = await Promise.all([service.getBootstrap(), service.getSettings()])
        if (!active) return
        setData(next)
        setSettings(nextSettings)
        setEventId(next.events.find((x) => x.active)?.id || next.events[0]?.id || '')
        setBoot('app')
      } catch (reason) {
        if (active) {
          setBootError(messageOf(reason))
          setBoot('error')
        }
      }
    })()
    return () => {
      active = false
    }
  }, [service])

  const refresh = async () => {
    const next = await service.getBootstrap()
    setData(next)
    setEventId((id) => id || next.events.find((x) => x.active)?.id || next.events[0]?.id || '')
  }

  const selectEvent = async (id: string) => {
    await service.setActiveEvent(id)
    setEventId(id)
    setCart([])
    setAppliedPromo(null)
    await refresh()
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F2' && cart.length && screen === 'pos') {
        e.preventDefault()
        setCheckout(true)
        setMobile(false)
      }
      if (e.key === 'Escape') {
        setCheckout(false)
        setMobile(false)
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [cart.length, screen])

  useEffect(() => {
    if (!appliedPromo || !data?.bundles) return
    const bundle = data.bundles.find((b) => b.id === appliedPromo.id)
    if (!bundle || !bundle.active) {
      setAppliedPromo(null)
      return
    }
    const satisfies = bundle.items.every((item) => {
      const inCart = cart.find((c) => c.variantId === item.variantId)
      return inCart && inCart.quantity >= item.quantity
    })
    if (!satisfies) {
      setAppliedPromo(null)
    }
  }, [cart, appliedPromo, data?.bundles])

  const availablePromo = useMemo(() => {
    if (!data?.bundles?.length || !cart.length) return null
    const activeBundles = data.bundles.filter((b) => b.active)
    for (const b of activeBundles) {
      if (appliedPromo?.id === b.id) continue
      const satisfies = b.items.every((item) => {
        const inCart = cart.find((c) => c.variantId === item.variantId)
        return inCart && inCart.quantity >= item.quantity
      })
      if (satisfies) {
        const regularPrice = b.items.reduce((s, it) => {
          const inCart = cart.find((c) => c.variantId === it.variantId)
          return s + (inCart?.price ?? 0) * it.quantity
        }, 0)
        if (regularPrice > b.price) {
          return b
        }
      }
    }
    return null
  }, [data?.bundles, cart, appliedPromo])

  if (boot === 'loading') return <div className="loading-screen"><BrandMark /><span className="spinner dark" /><p>Menyiapkan data offline…</p></div>
  if (boot === 'error') return <main className="loading-screen"><BrandMark /><Alert>{bootError || 'Data lokal tidak dapat dibuka.'}</Alert><button className="button primary" onClick={() => window.location.reload()}>Coba lagi</button></main>
  if (!data || !settings) return <div className="loading-screen"><span className="spinner dark" /></div>

  const add = (p: Product, id: string) => {
    const v = p.variants.find((x) => x.id === id)
    if (!v?.stock) return
    setCart((old) => {
      const hit = old.find((x) => x.variantId === id)
      return hit
        ? old.map((x) => (x.variantId === id ? { ...x, quantity: Math.min(x.quantity + 1, x.stock) } : x))
        : [...old, { productId: p.id, productName: p.name, variantId: id, variantName: v.name, price: v.price, quantity: 1, stock: v.stock }]
    })
  }

  const addBundle = (b: PromoBundle) => {
    if (!data) return
    let canAdd = true
    for (const item of b.items) {
      const prod = data.products.find((p) => p.id === item.productId)
      const variant = prod?.variants.find((v) => v.id === item.variantId)
      const existingInCart = cart.find((c) => c.variantId === item.variantId)?.quantity || 0
      if (!variant || variant.stock < existingInCart + item.quantity) {
        canAdd = false
        break
      }
    }
    if (!canAdd) return

    setCart((old) => {
      let updated = [...old]
      for (const item of b.items) {
        const prod = data.products.find((p) => p.id === item.productId)!
        const variant = prod.variants.find((v) => v.id === item.variantId)!
        const hit = updated.find((x) => x.variantId === item.variantId)
        if (hit) {
          updated = updated.map((x) => (x.variantId === item.variantId ? { ...x, quantity: Math.min(x.quantity + item.quantity, x.stock) } : x))
        } else {
          updated.push({
            productId: prod.id,
            productName: prod.name,
            variantId: variant.id,
            variantName: variant.name,
            price: variant.price,
            quantity: item.quantity,
            stock: variant.stock,
          })
        }
      }
      return updated
    })

    const regularPrice = b.items.reduce((s, it) => {
      const prod = data.products.find((p) => p.id === it.productId)
      const variant = prod?.variants.find((v) => v.id === it.variantId)
      return s + (variant?.price ?? 0) * it.quantity
    }, 0)
    const discount = Math.max(0, regularPrice - b.price)
    setAppliedPromo({ id: b.id, name: b.name, discount })
  }

  const applyPromo = (b: PromoBundle) => {
    if (!data) return
    const regularPrice = b.items.reduce((s, it) => {
      const prod = data.products.find((p) => p.id === it.productId)
      const variant = prod?.variants.find((v) => v.id === it.variantId)
      return s + (variant?.price ?? 0) * it.quantity
    }, 0)
    const discount = Math.max(0, regularPrice - b.price)
    setAppliedPromo({ id: b.id, name: b.name, discount })
  }

  const removePromo = () => setAppliedPromo(null)

  const quantity = (id: string, n: number) =>
    setCart((old) => (n <= 0 ? old.filter((x) => x.variantId !== id) : old.map((x) => (x.variantId === id ? { ...x, quantity: Math.min(n, x.stock) } : x))))

  const done = async (t: Transaction) => {
    await refresh()
    setCart([])
    setAppliedPromo(null)
    setCheckout(false)
    setMobile(false)
    setReceipt(t)
  }

  const navigate = (s: Screen) => {
    setScreen(s)
    setMobile(false)
    scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
      <Sidebar screen={screen} setScreen={navigate} cashierName={settings.defaultCashier} shopName={settings.shopName} />
      <main className="workspace">
        <AppHeader events={data.events} event={data.events.find((x) => x.id === eventId)} change={selectEvent} />
        {screen === 'pos' && (
          <PosScreen
            data={data}
            cart={cart}
            add={add}
            addBundle={addBundle}
            quantity={quantity}
            checkout={() => setCheckout(true)}
            mobile={mobile}
            setMobile={setMobile}
            appliedPromo={appliedPromo}
            removePromo={removePromo}
            availablePromo={availablePromo}
            applyPromo={applyPromo}
          />
        )}
        {screen === 'products' && <ProductsPage data={data} service={service} refresh={refresh} />}
        {screen === 'stock' && <StockPage data={data} service={service} refresh={refresh} />}
        {screen === 'events' && <EventsPage data={data} service={service} refresh={refresh} select={setEventId} />}
        {screen === 'reports' && <ReportsPage data={data} service={service} eventId={eventId} />}
        {screen === 'transactions' && <TransactionsPage data={data} service={service} refresh={refresh} receipt={setReceipt} />}
        {screen === 'settings' && (
          <>
            <MoreMenu navigate={navigate} />
            <SettingsPage service={service} settings={settings} setSettings={setSettings} />
          </>
        )}
      </main>
      <MobileNav screen={screen} setScreen={navigate} cartCount={cart.reduce((s, x) => s + x.quantity, 0)} openCart={() => setMobile(true)} />
      {checkout && (
        <CheckoutModal
          service={service}
          cart={cart}
          eventId={eventId}
          settings={settings}
          success={done}
          close={() => setCheckout(false)}
          discount={appliedPromo?.discount}
          promoName={appliedPromo?.name}
        />
      )}
      {receipt && <ReceiptModal service={service} transaction={receipt} shop={settings} close={() => { setReceipt(null); setScreen('pos') }} />}
    </div>
  )
}
