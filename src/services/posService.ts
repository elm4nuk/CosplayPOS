import { initialMockData } from '../data/mockData'
import type { BootstrapData, CartItem, Transaction } from '../types'

export type CreateTransactionInput = {
  eventId: string
  items: CartItem[]
  cashReceived: number
}

export interface PosService {
  getBootstrap(): Promise<BootstrapData>
  createTransaction(input: CreateTransactionInput): Promise<Transaction>
}

const wait = (ms = 350) => new Promise((resolve) => window.setTimeout(resolve, ms))
const clone = <T,>(value: T): T => structuredClone(value)
let store = clone(initialMockData)

/**
 * Development-only adapter. It deliberately mirrors business operations instead
 * of guessed URLs, so the real adapter can implement the documented contract.
 */
export const mockPosService: PosService = {
  async getBootstrap() {
    await wait(250)
    return clone(store)
  },
  async createTransaction(input) {
    await wait(700)
    const total = input.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
    if (input.cashReceived < total) throw new Error('Uang diterima masih kurang.')
    for (const item of input.items) {
      const product = store.products.find((candidate) => candidate.id === item.productId)
      const variant = product?.variants.find((candidate) => candidate.id === item.variantId)
      if (!variant || variant.stock < item.quantity) throw new Error(`Stok ${item.productName} baru saja berubah. Periksa keranjang.`)
    }
    input.items.forEach((item) => {
      const variant = store.products.find((product) => product.id === item.productId)?.variants.find((candidate) => candidate.id === item.variantId)
      if (variant) variant.stock -= item.quantity
    })
    const transaction: Transaction = {
      id: crypto.randomUUID(),
      number: `CCF-${String(262 + store.transactions.length).padStart(4, '0')}`,
      eventId: input.eventId,
      createdAt: new Date().toISOString(),
      cashierName: 'Kasir Demo',
      items: clone(input.items),
      total,
      cashReceived: input.cashReceived,
      change: input.cashReceived - total,
      status: 'completed',
    }
    store.transactions.unshift(transaction)
    return clone(transaction)
  },
}

export const resetMockStore = () => { store = clone(initialMockData) }
