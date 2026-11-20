/** Stroke paths on a 20x20 grid for the host icon names the LAZERS panels request. */
const p = (d: string) => d
export const iconPaths: Record<string, string> = {
  "chevron-down": p("M5 8l5 5 5-5"),
  "chevron-right": p("M8 5l5 5-5 5"),
  "chevron-left": p("M12 5l-5 5 5 5"),
  "arrow-right": p("M4 10h12M11 5l5 5-5 5"),
  close: p("M5 5l10 10M15 5L5 15"),
  refresh: p("M16 10a6 6 0 1 1-2-4.5M16 3v4h-4"),
  "magnifying-glass": p("M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM14 14l4 4"),
  link: p("M8.5 11.5l3-3M7 9L5.5 10.5a3 3 0 0 0 4 4L11 13M13 11l1.5-1.5a3 3 0 0 0-4-4L9 7"),
  "outline-dots": p("M5 10h.01M10 10h.01M15 10h.01"),
  "circle-exclamation": p("M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5v4M10 13h.01"),
  "file-document": p("M6 3h5l4 4v10H6zM11 3v4h4M8 11h5M8 14h5"),
  "zoom-in": p("M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM14 14l4 4M9 6.5v5M6.5 9h5"),
  "zoom-out": p("M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM14 14l4 4M6.5 9h5"),
  task: p("M4 5l2 2 3-3M12 5h5M4 11l2 2 3-3M12 11h5M12 16h5"),
  status: p("M3 10h3l2-5 4 10 2-5h3"),
  models: p("M10 3l6 3.5v7L10 17l-6-3.5v-7zM10 10l6-3.5M10 10v7M10 10L4 6.5"),
  fit: p("M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4"),
  eye: p(
    "M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10zM10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z",
  ),
  expand: p("M4 8V4h4M12 16h4v-4M4 4l5 5M16 16l-5-5"),
  branch: p("M6 4v12M14 4v3a3 3 0 0 1-3 3H8"),
  check: p("M4 10.5l4 4 8-9"),
  plus: p("M10 4v12M4 10h12"),
}
