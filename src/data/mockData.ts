import type { BootstrapData } from '../types'

export const initialMockData: BootstrapData = {
  categories: [
    { id: 'all', name: 'Semua', color: '#18181b' },
    { id: 'print', name: 'Print', color: '#f472b6' },
    { id: 'charm', name: 'Charm', color: '#8b5cf6' },
    { id: 'apparel', name: 'Apparel', color: '#14b8a6' },
    { id: 'bundle', name: 'Bundle', color: '#f59e0b' },
  ],
  products: [
    { id: 'p1', name: 'Print Cosmic Parade', categoryId: 'print', description: 'A5, art paper 260 gsm', accent: '#ffd6e7', featured: true, variants: [{ id: 'v1', name: 'A5', price: 25000, stock: 18, sku: 'PR-CP-A5' }, { id: 'v2', name: 'A4', price: 40000, stock: 7, sku: 'PR-CP-A4' }] },
    { id: 'p2', name: 'Acrylic Charm Mochi', categoryId: 'charm', description: 'Double-sided, 6 cm', accent: '#e9ddff', featured: true, variants: [{ id: 'v3', name: 'Pink', price: 35000, stock: 12, sku: 'AC-MC-PK' }, { id: 'v4', name: 'Mint', price: 35000, stock: 0, sku: 'AC-MC-MT' }] },
    { id: 'p3', name: 'Sticker Pack Sidekick', categoryId: 'print', description: 'Isi 6 stiker vinyl', accent: '#d7f7ee', featured: true, variants: [{ id: 'v5', name: 'Set', price: 20000, stock: 24, sku: 'ST-SD-SET' }] },
    { id: 'p4', name: 'Tote Bag Star Crew', categoryId: 'apparel', description: 'Canvas tebal, sablon dua sisi', accent: '#fff0bd', variants: [{ id: 'v6', name: 'Cream', price: 85000, stock: 4, sku: 'TB-SC-CR' }, { id: 'v7', name: 'Black', price: 85000, stock: 3, sku: 'TB-SC-BK' }] },
    { id: 'p5', name: 'Photocard Dreamer', categoryId: 'print', description: 'Holographic finish', accent: '#cfe9ff', variants: [{ id: 'v8', name: 'Random', price: 15000, stock: 31, sku: 'PC-DR-RD' }] },
    { id: 'p6', name: 'Bundle Booth Bestie', categoryId: 'bundle', description: 'Print + charm + sticker', accent: '#ffe0ca', featured: true, variants: [{ id: 'v9', name: 'Bundle', price: 75000, stock: 6, sku: 'BD-BB-SET' }] },
    { id: 'p7', name: 'Enamel Pin Tiny Hero', categoryId: 'charm', description: 'Hard enamel, 3 cm', accent: '#dce8ff', variants: [{ id: 'v10', name: 'Gold', price: 50000, stock: 0, sku: 'EP-TH-GD' }] },
    { id: 'p8', name: 'Lanyard Cloud Club', categoryId: 'apparel', description: 'Soft polyester, 45 cm', accent: '#dcfce7', variants: [{ id: 'v11', name: 'Sky', price: 45000, stock: 11, sku: 'LY-CC-SK' }] },
  ],
  events: [
    { id: 'e1', name: 'Cosplay Creative Fest 2026', venue: 'Jakarta Convention Hall · Booth C-14', dateLabel: '16–18 Okt 2026', active: true },
    { id: 'e2', name: 'Creator Alley Weekend', venue: 'Bandung Creative Hub', dateLabel: '8–9 Nov 2026', active: false },
  ],
  transactions: [
    { id: 't1', number: 'CCF-0261', eventId: 'e1', createdAt: '2026-10-16T10:32:00+07:00', cashierName: 'Kasir Demo', items: [{ productId: 'p1', productName: 'Print Cosmic Parade', variantId: 'v1', variantName: 'A5', price: 25000, quantity: 2, stock: 18 }], total: 50000, cashReceived: 50000, change: 0, status: 'completed' },
    { id: 't2', number: 'CCF-0260', eventId: 'e1', createdAt: '2026-10-16T10:24:00+07:00', cashierName: 'Kasir Demo', items: [{ productId: 'p6', productName: 'Bundle Booth Bestie', variantId: 'v9', variantName: 'Bundle', price: 75000, quantity: 1, stock: 6 }], total: 75000, cashReceived: 100000, change: 25000, status: 'completed' },
  ],
  stockAdjustments: [
    { id: 's1', productName: 'Print Cosmic Parade', variantName: 'A5', delta: 20, reason: 'Stok awal event', createdAt: '16 Okt, 08.05', actor: 'Kasir Demo' },
    { id: 's2', productName: 'Acrylic Charm Mochi', variantName: 'Mint', delta: -2, reason: 'Rusak saat display', createdAt: '16 Okt, 09.12', actor: 'Kasir Dua' },
    { id: 's3', productName: 'Bundle Booth Bestie', variantName: 'Bundle', delta: 8, reason: 'Restock booth', createdAt: '16 Okt, 09.40', actor: 'Kasir Demo' },
  ],
}
