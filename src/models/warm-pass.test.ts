import { expect, test } from "bun:test"
import { WarmGate } from "./warm-pass.ts"

test("an unchanged project does no warm work; a moved revision or new input does", async () => {
  const gate = new WarmGate()
  let warms = 0
  const warm = async () => {
    warms++
  }
  const inputs = new Map([["overview-a", { input: { filters: "a" } }]])
  const never = () => false
  for (let tick = 0; tick < 5; tick++) await gate.pass("/project", 7, inputs, warm, never)
  // Five 15 s ticks, one warm.
  expect(warms).toBe(1)
  expect(gate.counts).toEqual({ ran: 1, hit: 4 })

  await gate.pass("/project", 8, inputs, warm, never)
  expect(warms).toBe(2)
  inputs.set("overview-b", { input: { filters: "b" } })
  await gate.pass("/project", 8, inputs, warm, never)
  expect(warms).toBe(4)
})

test("a pass cut short or failed is retried on the next tick", async () => {
  const gate = new WarmGate()
  let warms = 0
  const inputs = new Map([["a", { input: 1 }]])
  await gate.pass(
    "/p",
    1,
    inputs,
    async () => {
      warms++
    },
    () => true,
  )
  expect(warms).toBe(0)
  await gate.pass(
    "/p",
    1,
    inputs,
    async () => {
      warms++
      throw new Error("boom")
    },
    () => false,
  )
  expect(warms).toBe(1)
  await gate.pass(
    "/p",
    1,
    inputs,
    async () => {
      warms++
    },
    () => false,
  )
  expect(warms).toBe(2)
  await gate.pass(
    "/p",
    1,
    inputs,
    async () => {
      warms++
    },
    () => false,
  )
  expect(warms).toBe(2)
})
