import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2, Upload, X } from 'lucide-react'
import { optimizeImageFile } from '../../platform/images'
import type { Category, Product, ProductVariant } from '../../types'

type VariantDraft = Pick<ProductVariant, 'name' | 'price' | 'stock' | 'sku'> & { id?: string }

export type ProductFormValue = {
  id?: string
  name: string
  categoryId: string
  description: string
  accent: string
  image: string
  variants: VariantDraft[]
}

type Props = {
  product?: Product | null
  categories: Category[]
  close: () => void
  save: (value: ProductFormValue) => Promise<void>
}

const emptyVariant = (): VariantDraft => ({ name: '', price: 0, stock: 0, sku: '' })

export function ProductFormModal({ product, categories, close, save }: Props) {
  const initialVariants = product?.variants.length
    ? product.variants.map(({ id, name, price, stock, sku }) => ({ id, name, price, stock, sku }))
    : [{ ...emptyVariant(), name: 'Default' }]
  const [variants, setVariants] = useState<VariantDraft[]>(initialVariants)
  const [multi, setMulti] = useState(initialVariants.length > 1)
  const [photo, setPhoto] = useState(product?.image ?? '')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoBroken, setPhotoBroken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const updateVariant = (index: number, patch: Partial<VariantDraft>) => {
    setVariants((current) => current.map((variant, i) => i === index ? { ...variant, ...patch } : variant))
  }

  const moveVariant = (index: number, offset: -1 | 1) => {
    setVariants((current) => {
      const destination = index + offset
      if (destination < 0 || destination >= current.length) return current
      const next = [...current]
      ;[next[index], next[destination]] = [next[destination], next[index]]
      return next
    })
  }

  const removeVariant = (index: number) => {
    const target = variants[index]
    if (target.id) {
      setError('Varian tersimpan tidak boleh dihapus dari UI karena mungkin dirujuk transaksi lama. API arsip varian masih menunggu kontrak service.')
      return
    }
    setVariants((current) => current.filter((_, i) => i !== index))
  }

  const setSimpleMode = () => {
    if (variants.length > 1 && variants.slice(1).some((variant) => variant.id)) {
      setError('Produk dengan varian tersimpan tidak dapat kembali ke mode sederhana tanpa mengarsipkan varian melalui service.')
      return
    }
    setVariants((current) => [{ ...current[0], name: 'Default' }])
    setMulti(false)
    setError('')
  }

  const handlePhoto = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('File harus berupa gambar JPG, PNG, atau WebP.'); return }
    if (file.size > 5 * 1024 * 1024) { setError('Ukuran foto maksimal 5 MB.'); return }
    setPhotoBusy(true)
    setError('')
    try {
      setPhoto(await optimizeImageFile(file, 640))
      setPhotoBroken(false)
    } catch {
      setError('Gagal memproses foto. Coba gambar lain.')
    } finally {
      setPhotoBusy(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (!variants.length) { setError('Tambahkan minimal satu varian.'); return }
    if (variants.some((variant) => !variant.name.trim())) { setError('Nama setiap varian wajib diisi.'); return }
    setBusy(true)
    setError('')
    try {
      await save({
        id: product?.id,
        name: String(form.get('name')).trim(),
        categoryId: String(form.get('category')),
        description: String(form.get('description')).trim(),
        accent: product?.accent ?? '#b8e5ff',
        image: photo,
        variants: variants.map((variant) => ({ ...variant, name: multi ? variant.name.trim() : 'Default' })),
      })
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Produk tidak dapat disimpan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-layer" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
      <section className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="product-form-title">
        <div className="modal-head">
          <h2 id="product-form-title">{product ? `Edit ${product.name}` : 'Produk baru'}</h2>
          <button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="Tutup"><X /></button>
        </div>
        <form className="stack-form product-form" onSubmit={submit}>
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="photo-upload-container">
            <span className="photo-upload-label">Foto produk</span>
            {photo && !photoBroken ? (
              <div className="photo-preview-box">
                <img src={photo} alt="Pratinjau foto produk" className="photo-preview" onError={() => { setPhotoBroken(true); setError('Pratinjau foto gagal dimuat.') }} />
                <div className="photo-preview-actions">
                  <label className={`button secondary small change-photo-btn ${photoBusy ? 'disabled' : ''}`}>
                    <Upload size={15} />{photoBusy ? 'Memproses…' : 'Ganti foto'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={photoBusy} onChange={(event) => void handlePhoto(event.target.files?.[0])} />
                  </label>
                  <button type="button" className="button ghost small remove-photo-btn" onClick={() => { setPhoto(''); setPhotoBroken(false) }} disabled={photoBusy}><Trash2 size={15} />Hapus</button>
                </div>
              </div>
            ) : (
              <label className={`photo-dropzone ${photoBusy ? 'disabled' : ''}`}>
                <ImagePlus size={28} />
                <span>{photoBusy ? 'Memproses foto…' : 'Unggah foto produk'}</span>
                <small>JPG, PNG, WebP · maksimal 5 MB</small>
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={photoBusy} onChange={(event) => void handlePhoto(event.target.files?.[0])} />
              </label>
            )}
          </div>
          <label>Nama produk<input name="name" autoFocus defaultValue={product?.name ?? ''} required placeholder="Contoh: Acrylic Keychain" /></label>
          <label>Kategori<select name="category" defaultValue={product?.categoryId ?? categories[0]?.id} required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>Deskripsi<input name="description" defaultValue={product?.description ?? ''} placeholder="Contoh: Acrylic dua sisi" /></label>

          <fieldset className="variant-fieldset">
            <legend>Varian produk</legend>
            <div className="variant-mode" role="group" aria-label="Mode varian">
              <button type="button" className={!multi ? 'active' : ''} aria-pressed={!multi} onClick={setSimpleMode}>Sederhana</button>
              <button type="button" className={multi ? 'active' : ''} aria-pressed={multi} onClick={() => { setMulti(true); setError('') }}>Multi-varian</button>
            </div>
            {!multi ? (
              <div className="form-grid form-grid-2">
                <label>Harga (Rp)<input aria-label="Harga" type="number" min="0" value={variants[0]?.price ?? 0} onChange={(event) => updateVariant(0, { price: Number(event.target.value) })} required /></label>
                <label>{product ? 'Jumlah stok' : 'Stok awal'}<input aria-label={product ? 'Jumlah stok' : 'Stok awal'} type="number" min="0" value={variants[0]?.stock ?? 0} onChange={(event) => updateVariant(0, { stock: Number(event.target.value) })} required /></label>
              </div>
            ) : (
              <div className="variant-editor">
                {variants.map((variant, index) => (
                  <div className="variant-editor-row" key={variant.id ?? `new-${index}`}>
                    <div className="variant-row-head"><b>Varian {index + 1}</b>{variant.id && <small>Varian tersimpan</small>}</div>
                    <label>Nama varian<input aria-label={`Nama varian ${index + 1}`} value={variant.name === 'Default' ? '' : variant.name} onChange={(event) => updateVariant(index, { name: event.target.value })} placeholder="Contoh: A5" required /></label>
                    <label>Harga (Rp)<input aria-label={`Harga varian ${index + 1}`} type="number" min="0" value={variant.price} onChange={(event) => updateVariant(index, { price: Number(event.target.value) })} required /></label>
                    <label>Stok<input aria-label={`Stok varian ${index + 1}`} type="number" min="0" value={variant.stock} onChange={(event) => updateVariant(index, { stock: Number(event.target.value) })} required /></label>
                    <label>SKU (opsional)<input aria-label={`SKU varian ${index + 1}`} value={variant.sku} onChange={(event) => updateVariant(index, { sku: event.target.value })} placeholder="PRINT-A5" /></label>
                    <div className="variant-row-actions">
                      <button type="button" className="icon-button" aria-label={`Naikkan varian ${index + 1}`} disabled={index === 0} onClick={() => moveVariant(index, -1)}><ArrowUp /></button>
                      <button type="button" className="icon-button" aria-label={`Turunkan varian ${index + 1}`} disabled={index === variants.length - 1} onClick={() => moveVariant(index, 1)}><ArrowDown /></button>
                      <button type="button" className="icon-button button-danger-ghost" aria-label={`${variant.id ? 'Arsipkan' : 'Hapus'} varian ${index + 1}`} disabled={variants.length === 1 || Boolean(variant.id)} title={variant.id ? 'Menunggu API arsip varian' : 'Hapus varian'} onClick={() => removeVariant(index)}><Trash2 /></button>
                    </div>
                  </div>
                ))}
                <button type="button" className="button secondary" onClick={() => setVariants((current) => [...current, emptyVariant()])}><Plus />Tambah varian</button>
              </div>
            )}
          </fieldset>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={close} disabled={busy}>Batal</button>
            <button type="submit" className="button primary grow" disabled={busy || photoBusy}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
