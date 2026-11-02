import type { RadarLayoutInput } from "./layout-ipc.ts"
import type { RadarMapEdge, RadarMapModel, RadarMapNode } from "./map-model.ts"

export type RadarMapText = {
  label: string[]
  subtitle: string[]
  status: string[]
}

export type MeasuredRadarMap = {
  input: RadarLayoutInput
  text: Map<string, RadarMapText>
}

const GROUPS = [
  ["runtime", "LAZERS runtime"],
  ["work", "Plans and tasks"],
  ["sessions", "Native sessions"],
  ["routes", "Model routes"],
  ["tools", "Native tools"],
] as const

const EDGE_LABELS: Record<RadarMapEdge["kind"], string> = {
  architecture: "architecture",
  ancestry: "parent session",
  association: "association",
  dependency: "dependency",
  assignment: "dispatch",
  prompt: "prompt delivery",
  outcome: "outcome delivery",
  "model-request": "model request",
  "model-response": "model response",
  "tool-call": "tool call",
  "tool-result": "tool result",
  observation: "observation",
  contains: "contains",
  "selected-route": "selected route",
  "configured-route": "configured route",
}

function hash(value: string) {
  let result = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    result ^= BigInt(byte)
    result = BigInt.asUintN(64, result * 0x100000001b3n)
  }
  return result.toString(16).padStart(16, "0")
}

function wrapped(text: string, maxWidth: number, measure: (value: string) => number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (measure(word) > maxWidth) {
      if (current) {
        lines.push(current)
      }
      let fragment = ""
      for (const character of word) {
        if (fragment && measure(fragment + character) > maxWidth) {
          lines.push(fragment)
          fragment = character
        } else fragment += character
      }
      current = fragment
      continue
    }
    const candidate = current ? `${current} ${word}` : word
    if (current && measure(candidate) > maxWidth) {
      lines.push(current)
      current = word
    } else current = candidate
  }
  if (current) lines.push(current)
  return lines.length ? lines : [""]
}

function compactLines(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  maxLines: number,
) {
  const lines = wrapped(text, maxWidth, measure)
  if (lines.length <= maxLines) return lines
  const visible = lines.slice(0, maxLines)
  let last = visible[maxLines - 1] ?? ""
  while (last && measure(`${last}…`) > maxWidth) last = [...last].slice(0, -1).join("")
  visible[maxLines - 1] = `${last}…`
  return visible
}

function nodeGeometry(node: RadarMapNode, measure: (value: string) => number) {
  const maxContentWidth = 272
  const label = compactLines(node.label, maxContentWidth, measure, 2)
  const subtitle = compactLines(node.subtitle, maxContentWidth, measure, 2)
  const status = compactLines(node.status, maxContentWidth, measure, 2)
  const textWidth = Math.max(...[...label, ...subtitle, ...status].map(measure), 0)
  const width = Math.min(304, Math.max(184, Math.ceil(textWidth + 26)))
  const height = Math.max(
    76,
    18 + label.length * 18 + subtitle.length * 15 + status.length * 13 + 18,
  )
  return { label, subtitle, status, width, height }
}

export function edgeLabel(kind: RadarMapEdge["kind"]) {
  return EDGE_LABELS[kind]
}

export function measureRadarMap(
  model: RadarMapModel,
  scopeKey: string,
  fontKey: string,
  measure: (text: string) => number,
): MeasuredRadarMap {
  const text = new Map<string, RadarMapText>()
  const nodeDimensions = model.nodes.map((node) => {
    const geometry = nodeGeometry(node, measure)
    text.set(node.id, {
      label: geometry.label,
      subtitle: geometry.subtitle,
      status: geometry.status,
    })
    return {
      id: node.id,
      group: node.group,
      width: geometry.width,
      height: geometry.height,
    }
  })
  const usedGroups = new Set(nodeDimensions.map((node) => node.group))
  const groups = GROUPS.filter(([id]) => usedGroups.has(id)).map(([id, label]) => ({
    id,
    label,
    width: Math.ceil(measure(label) + 20),
    height: 20,
  }))
  const nodes = new Set(nodeDimensions.map((node) => node.id))
  const edgeDimensions = model.edges.flatMap((edge) => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return []
    const label = edgeLabel(edge.kind)
    return [
      {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label,
        labelWidth: Math.ceil(measure(label) + 14),
        labelHeight: 16,
      },
    ]
  })
  const geometry = JSON.stringify([
    scopeKey,
    fontKey,
    groups.map(({ id, label, width, height }) => [id, label, width, height]),
    nodeDimensions.map(({ id, group, width, height }) => [id, group, width, height]),
    edgeDimensions.map(({ id, source, target, label, labelWidth, labelHeight }) => [
      id,
      source,
      target,
      label,
      labelWidth,
      labelHeight,
    ]),
  ])
  return {
    input: {
      key: hash(geometry),
      scopeKey: hash(scopeKey),
      groups,
      nodes: nodeDimensions,
      edges: edgeDimensions,
    },
    text,
  }
}

export function defaultTextMeasure(value: string) {
  return [...value].length * 7.2
}
