import { render } from "solid-js/web"
import {
  ActivityLane,
  Callout,
  Coverage,
  Disclosure,
  Identifiers,
  Label,
  Progress,
  Row,
  Rows,
  StatRow,
} from "../components.tsx"

export function mountKit(container: HTMLElement) {
  return render(
    () => (
      <>
        <section id="stats-empty">
          <StatRow stats={[{ label: "Age" }, { label: "Runtime", value: "" }]} />
        </section>
        <section id="stats-some">
          <StatRow
            stats={[
              { label: "Age", value: "1d 20h" },
              { label: "Runtime" },
              { label: "Calls", value: "17 · 5 files" },
              { label: "Model", value: "gpt" },
              { label: "Extra", value: "x" },
            ]}
          />
        </section>
        <section id="label">
          <Label tone="warning">partial</Label>
          <Label tone="critical">idle</Label>
        </section>
        <section id="progress">
          <Progress steps={["Queued", "Working", "Checks"]} current={1} tone="warning" />
          <Progress steps={["Queued", "Done"]} current={1} tone="success" />
        </section>
        <section id="lane">
          <ActivityLane
            label="Activity"
            ticks={Array.from({ length: 5000 }, (_, i) => ({ at: i * 10, failed: i === 2500 }))}
            maxMarks={100}
            start="12:58"
            end="now"
          />
        </section>
        <section id="coverage-empty">
          <Coverage priced={0} unpriced={0} caption="x" />
        </section>
        <section id="coverage">
          <Coverage priced={3} unpriced={1} caption="3 calls priced" note="no price" />
        </section>
        <section id="rows-empty">
          <Rows columns="1fr" items={[]}>
            {() => <Row>x</Row>}
          </Rows>
        </section>
        <section id="rows">
          <Rows columns="1fr 60px" header={["Tool", "Time"]} items={["a", "b"]}>
            {(item) => (
              <Row onSelect={() => undefined}>
                <span>{item}</span>
                <span>1s</span>
              </Row>
            )}
          </Rows>
        </section>
        <section id="disc-count0">
          <Disclosure label="Events" count={0}>
            hidden
          </Disclosure>
        </section>
        <section id="disc-when">
          <Disclosure label="Files" when={false}>
            hidden
          </Disclosure>
        </section>
        <section id="disc">
          <Disclosure label="Events" count={165}>
            BODY
          </Disclosure>
        </section>
        <section id="callout">
          <Callout icon={<i />} iconTone="waiting" text="Interrupted." raw="raw detail" />
        </section>
        <section id="ids-empty">
          <Identifiers items={[{ label: "Task", value: "" }, { label: "Plan" }]} />
        </section>
        <section id="ids">
          <Identifiers items={[{ label: "Task", value: "abc" }, { label: "Plan" }]} />
        </section>
      </>
    ),
    container,
  )
}
