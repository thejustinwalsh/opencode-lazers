/**
 * How a design-size iframe fits its plate. The iframe renders at the panel's design size and is
 * scaled with a transform from its top-left corner; the plate reserves the scaled height with an
 * aspect ratio, so the scaled iframe's box equals the plate's content box.
 */
export interface DesignSize {
  width: number
  height: number
}

/** Scale that makes a design-width iframe as wide as its plate's content box. */
export const fitScale = (plateWidth: number, design: DesignSize) =>
  plateWidth > 0 ? plateWidth / design.width : 0

/** The scaled iframe's size on the page, in CSS px. */
export const scaledBox = (plateWidth: number, design: DesignSize) => {
  const scale = fitScale(plateWidth, design)
  return { width: design.width * scale, height: design.height * scale }
}

/** The plate's content height from its width and the design's aspect ratio. */
export const plateHeight = (plateWidth: number, design: DesignSize) =>
  (plateWidth * design.height) / design.width

/**
 * Inline style for the iframe. Preact does not append "px" to numbers, and a unitless width is
 * silently dropped (the iframe then falls back to 300x150), so every length is a string.
 */
export const frameStyle = (design: DesignSize, scale: number) => ({
  width: `${design.width}px`,
  height: `${design.height}px`,
  transform: `scale(${scale})`,
})
