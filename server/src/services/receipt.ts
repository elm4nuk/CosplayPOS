import type { Ctx } from '../context.ts';
import { localParts } from '../lib/time.ts';
import { getEvent } from './events.ts';
import { getSettings } from './settings.ts';
import { getTransaction, type Transaction } from './transactions.ts';

export interface ReceiptData {
  store: { name: string; address: string | null; phone: string | null; header: string | null; footer: string | null };
  event: { id: number; code: string; name: string; location: string | null };
  transaction: Transaction;
  localTime: string;
  timezone: string;
}

export function getReceipt(ctx: Ctx, ref: string): ReceiptData {
  const transaction = getTransaction(ctx.store, ref);
  const settings = getSettings(ctx.store, ctx.config.timezone);
  const event = getEvent(ctx.store, transaction.eventId);
  return {
    store: {
      name: settings.storeName,
      address: settings.storeAddress,
      phone: settings.storePhone,
      header: settings.receiptHeader,
      footer: settings.receiptFooter,
    },
    event: { id: event.id, code: event.code, name: event.name, location: event.location },
    transaction,
    localTime: localParts(transaction.createdAt, ctx.config.timezone).display,
    timezone: ctx.config.timezone,
  };
}

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const rp = (n: number): string => `Rp${new Intl.NumberFormat('id-ID').format(n)}`;

/** Struk HTML mandiri (tanpa aset eksternal) untuk dicetak / disimpan sebagai PDF lewat dialog print browser. */
export function receiptHtml(r: ReceiptData, opts: { widthMm: 58 | 80; autoPrint: boolean }): string {
  const t = r.transaction;
  const paperWidth = opts.widthMm;
  const contentWidth = opts.widthMm === 58 ? 48 : 72;
  const items = t.items
    .map(
      (it) => `
      <div class="item">
        <div class="name">${esc(it.productName)}${it.variantName ? ` – ${esc(it.variantName)}` : ''}</div>
        <div class="row"><span>${it.quantity} × ${rp(it.unitPrice)}</span><span>${rp(it.lineTotal)}</span></div>
      </div>`,
    )
    .join('');
  const payment =
    t.paymentMethod === 'cash'
      ? `<div class="row"><span>Tunai</span><span>${rp(t.amountReceived)}</span></div>
         <div class="row"><span>Kembali</span><span>${rp(t.change)}</span></div>`
      : `<div class="row"><span>QRIS</span><span>${rp(t.amountReceived)}</span></div>
         ${t.qrisReference ? `<div class="muted">Ref: ${esc(t.qrisReference)}</div>` : ''}`;
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Struk ${esc(t.number)}</title>
<style>
  @page { size: ${paperWidth}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font: 12px/1.35 ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace; }
  .receipt { width: ${contentWidth}mm; margin: 0 auto; padding: 4mm 0; }
  .center { text-align: center; }
  .store { font-size: 14px; font-weight: 700; }
  .muted { color: #333; font-size: 11px; }
  .row { display: flex; justify-content: space-between; gap: 4px; }
  .row span:last-child { text-align: right; white-space: nowrap; }
  .item { margin: 2px 0; }
  .name { word-break: break-word; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .total { font-weight: 700; font-size: 13px; }
  .void { border: 2px solid #000; text-align: center; font-weight: 700; margin: 4px 0; padding: 2px; }
  .toolbar { text-align: center; margin: 12px 0; }
  .toolbar button { font: inherit; padding: 6px 14px; }
  @media print { .toolbar { display: none; } }
</style>
</head>
<body>
<div class="receipt">
  <div class="center store">${esc(r.store.name)}</div>
  ${r.store.address ? `<div class="center muted">${esc(r.store.address)}</div>` : ''}
  ${r.store.phone ? `<div class="center muted">${esc(r.store.phone)}</div>` : ''}
  ${r.store.header ? `<div class="center muted">${esc(r.store.header)}</div>` : ''}
  <div class="center muted">${esc(r.event.name)}</div>
  <hr>
  <div class="row"><span>No</span><span>${esc(t.number)}</span></div>
  <div class="row"><span>Waktu</span><span>${esc(r.localTime)}</span></div>
  <div class="row"><span>Kasir</span><span>${esc(t.cashier.displayName)}</span></div>
  ${t.status === 'voided' ? `<div class="void">DIBATALKAN</div>` : ''}
  <hr>
  ${items}
  <hr>
  <div class="row total"><span>TOTAL</span><span>${rp(t.total)}</span></div>
  ${payment}
  ${t.note ? `<div class="muted">Catatan: ${esc(t.note)}</div>` : ''}
  <hr>
  ${r.store.footer ? `<div class="center">${esc(r.store.footer)}</div>` : ''}
</div>
<div class="toolbar"><button onclick="window.print()">Cetak / Simpan PDF</button></div>
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},150)})</script>' : ''}
</body>
</html>`;
}
