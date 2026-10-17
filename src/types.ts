export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline'

export type Category = { id: string; name: string; color: string }

export type ProductVariant = {
  id: string
  name: string
  price: number
  stock: number
  sku: string
}

export type Product = {
  id: string
  name: string
  categoryId: string
  description: string
  accent: string
  image?: string
  featured?: boolean
  variants: ProductVariant[]
}

export type BoothEvent = {
  id: string
  name: string
  venue: string
  dateLabel: string
  active: boolean
}

export type CartItem = {
  productId: string
  productName: string
  variantId: string
  variantName: string
  price: number
  quantity: number
  stock: number
}

export type PromoBundleItem = {
  productId: string
  variantId: string
  quantity: number
}

export type PromoBundle = {
  id: string
  name: string
  description?: string
  price: number
  items: PromoBundleItem[]
  active: boolean
}

export type PaymentMethod = 'cash' | 'qris'

export type Transaction = {
  id: string
  number: string
  eventId: string
  createdAt: string
  cashierName: string
  items: CartItem[]
  subtotal?: number
  discount?: number
  promoName?: string
  total: number
  cashReceived: number
  change: number
  paymentMethod?: PaymentMethod
  status: 'completed' | 'void'
  voidedAt?: string
  voidReason?: string
}

export type StockAdjustment = {
  id: string
  productName: string
  variantName: string
  delta: number
  reason: string
  createdAt: string
  actor: string
}

export type BootstrapData = {
  products: Product[]
  categories: Category[]
  events: BoothEvent[]
  transactions: Transaction[]
  stockAdjustments: StockAdjustment[]
  bundles: PromoBundle[]
}
