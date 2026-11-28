interface Order {
  weightKg: number
  country: string
  express: boolean
  total: number
}

function shippingCost(order: Order): number {
  if (order.total >= 100 && !order.express) return 0
  let cost = 5
  if (order.country === "NL" || order.country === "BE") {
    cost = order.weightKg > 10 ? 9 : 5
  } else if (order.country === "US") {
    if (order.weightKg > 20) {
      cost = 40
    } else if (order.weightKg > 5) {
      cost = 25
    } else {
      cost = 15
    }
  } else {
    for (const limit of [1, 5, 10, 20]) {
      if (order.weightKg > limit) cost += 6
    }
  }
  if (order.express) {
    cost = order.country === "NL" ? cost + 7 : cost * 2
  }
  return cost
}

export { shippingCost as headShippingCost }
