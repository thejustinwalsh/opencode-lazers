import * as stylex from "@stylexjs/stylex"
import { Cover } from "./Cover"
import { Checked, Footer, Install, Loop, Parts } from "./Sections"
import { color, type } from "./tokens.stylex"

const s = stylex.create({
  skip: {
    position: "absolute",
    zIndex: 10,
    left: 12,
    top: { default: -80, ":focus": 12 },
    paddingInline: 16,
    paddingBlock: 10,
    backgroundColor: color.magenta,
    color: color.paper,
    fontFamily: type.face,
    fontStretch: "75%",
    fontStyle: "italic",
    fontWeight: 800,
    textTransform: "uppercase",
    textDecoration: "none",
  },
  main: { outline: "none" },
})

export function App() {
  return (
    <>
      <a href="#main" {...stylex.props(s.skip)}>
        Skip to content
      </a>
      <Cover />
      <main id="main" tabIndex={-1} {...stylex.props(s.main)}>
        <Loop />
        <Parts />
        <Checked />
        <Install />
      </main>
      <Footer />
    </>
  )
}
