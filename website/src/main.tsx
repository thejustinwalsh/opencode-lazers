import "@fontsource-variable/archivo/wdth.css"
import "@fontsource-variable/archivo/wdth-italic.css"
import "lenis/dist/lenis.css"
import "./global.css"
import { render } from "preact"
import { App } from "./App"
import { startMotion } from "./lib/motion"

render(<App />, document.getElementById("root")!)
startMotion()
