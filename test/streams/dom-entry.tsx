import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import {
  createStream,
  type GuiStreamOptions,
  type StreamsTransport,
} from "../../src/streams/gui.ts"
import { sourceRef } from "../../src/streams/source.ts"
import { itemColumns } from "../../src/streams/test-source.ts"

const source = sourceRef({ name: "test.items", columns: itemColumns })

/** A list showing 50 rows of a stream whose window is wider, plus one scroll control. */
export function harness(
  root: HTMLElement,
  transport: StreamsTransport,
  initial: GuiStreamOptions<object>,
  visible = 50,
) {
  const [options, setOptions] = createSignal(initial)
  const dispose = render(() => {
    const stream = createStream(transport, source, options)
    return (
      <div>
        <span aria-label="range">
          {stream.before()}/{stream.items().length}/{stream.after()}
        </span>
        <ul>
          <For each={stream.items().slice(0, visible)}>{(row) => <li>{String(row.title)}</li>}</For>
        </ul>
        <button onClick={() => stream.slide(25)}>scroll</button>
      </div>
    )
  }, root)
  return { dispose, setOptions }
}
