import { createMemo, mapArray } from "solid-js"
import type { Accessor, JSX } from "solid-js"

/** Key mounted views by canonical identity while reading their latest snapshot values. */
export function mapByKey<T, U>(
  each: Accessor<readonly T[]>,
  by: (item: T) => string,
  render: (item: Accessor<T>) => U,
): Accessor<U[]> {
  const values = createMemo(() => new Map(each().map((item) => [by(item), item])))
  return mapArray(
    () => [...values().keys()],
    (key) => {
      let current: T = values().get(key)!
      return render(() => {
        // Consumers may update before mapArray disposes a removed key's owner.
        // Keep its last value valid through that final reactive update.
        const next = values().get(key)
        if (next !== undefined) current = next
        return current
      })
    },
  )
}

export function Keyed<T>(props: {
  each: readonly T[]
  by: (item: T) => string
  children: (item: Accessor<T>) => JSX.Element
}): JSX.Element {
  // Like Solid's For, the returned accessor is evaluated by the renderer.
  return mapByKey(() => props.each, props.by, props.children) as unknown as JSX.Element
}
