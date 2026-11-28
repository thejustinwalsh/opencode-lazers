interface Order {
  weightKg: number
  country: string
  express: boolean
  total: number
}

function shippingCost(order: Order): number {
  if (order.total >= 100) return 0
  return order.express ? 12 : 5
}

export { shippingCost as baseShippingCost }
