import {
  JSCPD_DETECTOR_IDS,
  type ChangedLineRange,
  type ClonePair,
  type DuplicationInstance,
  type JscpdDetector,
} from "./contract.ts"

export interface CloneGroup {
  fingerprint: string
  instances: DuplicationInstance[]
  tokens: number
  lines: number
  kind: string
  similarity: number | undefined
}

export interface IntroducedClone {
  group: CloneGroup
  introduced: DuplicationInstance[]
  others: DuplicationInstance[]
  baseInstances: number
}

export interface MergedClone {
  primary: IntroducedClone
  detector: JscpdDetector
  detectors: JscpdDetector[]
  introduced: DuplicationInstance[]
  others: DuplicationInstance[]
  similarity: number | undefined
}

interface PairDraft {
  instances: DuplicationInstance[]
  best: ClonePair
  similarity: number | undefined
}

interface MergeEntry {
  primary: IntroducedClone
  detector: JscpdDetector
  detectors: Set<JscpdDetector>
  instances: DuplicationInstance[]
  similarity: number | undefined
}

const overlaps = (left: DuplicationInstance, right: DuplicationInstance) =>
  left.path === right.path && left.startLine <= right.endLine && right.startLine <= left.endLine

function hitsChange(
  changed: ReadonlyMap<string, readonly ChangedLineRange[]>,
  instance: DuplicationInstance,
): boolean {
  return (
    changed
      .get(instance.path)
      ?.some(
        (range) => range.startLine <= instance.endLine && instance.startLine <= range.endLine,
      ) ?? false
  )
}

export function changedLineMap(
  ranges: readonly ChangedLineRange[],
): ReadonlyMap<string, readonly ChangedLineRange[]> {
  const grouped = new Map<string, ChangedLineRange[]>()
  for (const range of ranges) {
    const values = grouped.get(range.path) ?? []
    values.push(range)
    grouped.set(range.path, values)
  }
  return grouped
}

/** jscpd reports pairs; locations connected by overlap are one clone group. */
function pairTouchesDraft(pair: ClonePair, draft: PairDraft): boolean {
  return [pair.first, pair.second].some((side) =>
    draft.instances.some((held) => overlaps(held, side)),
  )
}

function mergeDrafts(drafts: PairDraft[], hits: PairDraft[], pair: ClonePair): PairDraft {
  const target = hits[0] ?? { instances: [], best: pair, similarity: undefined }
  if (hits.length === 0) drafts.push(target)
  for (const other of hits.slice(1)) {
    target.instances.push(...other.instances)
    if (other.best.tokens > target.best.tokens) target.best = other.best
    drafts.splice(drafts.indexOf(other), 1)
  }
  return target
}

function addSide(draft: PairDraft, side: DuplicationInstance): void {
  const held = draft.instances.find((item) => overlaps(item, side))
  if (!held) {
    draft.instances.push({ ...side })
    return
  }
  held.startLine = Math.min(held.startLine, side.startLine)
  held.endLine = Math.max(held.endLine, side.endLine)
}

function addPair(drafts: PairDraft[], pair: ClonePair): void {
  const sides = [pair.first, pair.second]
  const hits = drafts.filter((draft) => pairTouchesDraft(pair, draft))
  const target = mergeDrafts(drafts, hits, pair)
  for (const side of sides) addSide(target, side)
  if (pair.tokens > target.best.tokens) target.best = pair
  if (pair.similarity !== undefined && pair.similarity < 1)
    target.similarity = Math.min(target.similarity ?? 1, pair.similarity)
}

function toCloneGroup(draft: PairDraft): CloneGroup {
  return {
    fingerprint: draft.best.fingerprint,
    instances: draft.instances.sort(
      (left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine,
    ),
    tokens: draft.best.tokens,
    lines: draft.best.lines,
    kind: draft.best.kind,
    similarity: draft.similarity,
  }
}

export function groupPairs(pairs: readonly ClonePair[]): CloneGroup[] {
  const drafts: PairDraft[] = []
  for (const pair of pairs) addPair(drafts, pair)
  return drafts.filter((draft) => draft.instances.length >= 2).map(toCloneGroup)
}

/** A head group is introduced only when its copy count grew and a copy touches changed lines. */
export function introducedClones(
  base: readonly CloneGroup[],
  head: readonly CloneGroup[],
  changed: ReadonlyMap<string, readonly ChangedLineRange[]>,
): IntroducedClone[] {
  const baseCounts = new Map<string, number>()
  for (const group of base)
    baseCounts.set(
      group.fingerprint,
      Math.max(baseCounts.get(group.fingerprint) ?? 0, group.instances.length),
    )

  const introduced: IntroducedClone[] = []
  for (const group of head) {
    const baseInstances = baseCounts.get(group.fingerprint) ?? 0
    if (baseInstances >= group.instances.length) continue
    const changedInstances = group.instances.filter((instance) => hitsChange(changed, instance))
    if (changedInstances.length === 0) continue
    introduced.push({
      group,
      introduced: changedInstances,
      others: group.instances.filter((instance) => !changedInstances.includes(instance)),
      baseInstances,
    })
  }
  return introduced
}

/** Merge detector reports when they share two or more source instances. */
function orderedCloneItems(
  found: readonly { detector: JscpdDetector; clones: readonly IntroducedClone[] }[],
) {
  const order = new Map(JSCPD_DETECTOR_IDS.map((id, index) => [id, index] as const))
  return found
    .flatMap(({ detector, clones }) => clones.map((clone) => ({ detector, clone })))
    .sort(
      (left, right) =>
        order.get(left.detector)! - order.get(right.detector)! ||
        right.clone.group.tokens - left.clone.group.tokens,
    )
}

function indexEntry(
  entry: MergeEntry,
  instance: DuplicationInstance,
  byPath: Map<string, MergeEntry[]>,
): void {
  const indexed = byPath.get(instance.path)
  if (!indexed) byPath.set(instance.path, [entry])
  else if (!indexed.includes(entry)) indexed.push(entry)
}

function matchingEntry(
  instances: readonly DuplicationInstance[],
  byPath: ReadonlyMap<string, readonly MergeEntry[]>,
): MergeEntry | undefined {
  const hits = new Map<MergeEntry, number>()
  for (const instance of instances) {
    for (const entry of byPath.get(instance.path) ?? []) {
      if (entry.instances.some((held) => overlaps(held, instance)))
        hits.set(entry, (hits.get(entry) ?? 0) + 1)
    }
  }
  return [...hits].find(([, count]) => count >= 2)?.[0]
}

function createEntry(clone: IntroducedClone, detector: JscpdDetector): MergeEntry {
  return {
    primary: clone,
    detector,
    detectors: new Set([detector]),
    instances: [...clone.introduced, ...clone.others],
    similarity: clone.group.similarity,
  }
}

function extendEntry(
  target: MergeEntry,
  clone: IntroducedClone,
  detector: JscpdDetector,
  byPath: Map<string, MergeEntry[]>,
): void {
  target.detectors.add(detector)
  target.similarity ??= clone.group.similarity
  if (clone.group.lines > target.primary.group.lines * 1.25) {
    target.primary = clone
    target.detector = detector
  }
  for (const instance of [...clone.introduced, ...clone.others]) {
    if (target.instances.some((held) => overlaps(held, instance))) continue
    target.instances.push(instance)
    indexEntry(target, instance, byPath)
  }
}

function addCloneToEntries(
  item: { detector: JscpdDetector; clone: IntroducedClone },
  entries: MergeEntry[],
  byPath: Map<string, MergeEntry[]>,
): void {
  const instances = [...item.clone.introduced, ...item.clone.others]
  const target = matchingEntry(instances, byPath)
  if (target) {
    extendEntry(target, item.clone, item.detector, byPath)
    return
  }
  const entry = createEntry(item.clone, item.detector)
  entries.push(entry)
  for (const instance of instances) indexEntry(entry, instance, byPath)
}

function detectorIds(entry: MergeEntry): JscpdDetector[] {
  const extensions = new Set(
    entry.instances.map((instance) =>
      instance.path.slice(instance.path.lastIndexOf(".") + 1).toLowerCase(),
    ),
  )
  const spansTypedAndPlain =
    [...extensions].some((extension) => ["ts", "tsx", "mts", "cts"].includes(extension)) &&
    [...extensions].some((extension) => ["js", "jsx", "mjs", "cjs"].includes(extension))
  return JSCPD_DETECTOR_IDS.filter(
    (detector) =>
      entry.detectors.has(detector) &&
      (detector !== "cross-language" ||
        spansTypedAndPlain ||
        entry.detectors.size === 1 ||
        entry.detector === detector),
  )
}

function mergedClone(
  entry: MergeEntry,
  changed: ReadonlyMap<string, readonly ChangedLineRange[]>,
): MergedClone {
  const primaryInstances = [...entry.primary.introduced, ...entry.primary.others]
  const ordered = [
    ...primaryInstances,
    ...entry.instances.filter(
      (instance) => !primaryInstances.some((primary) => overlaps(primary, instance)),
    ),
  ]
  return {
    primary: entry.primary,
    detector: entry.detector,
    detectors: detectorIds(entry),
    introduced: ordered.filter((instance) => hitsChange(changed, instance)),
    others: ordered.filter((instance) => !hitsChange(changed, instance)),
    similarity: entry.similarity,
  }
}

export function mergeClones(
  found: readonly { detector: JscpdDetector; clones: readonly IntroducedClone[] }[],
  changed: ReadonlyMap<string, readonly ChangedLineRange[]>,
): MergedClone[] {
  const entries: MergeEntry[] = []
  const byPath = new Map<string, MergeEntry[]>()
  for (const item of orderedCloneItems(found)) addCloneToEntries(item, entries, byPath)
  return entries.map((entry) => mergedClone(entry, changed))
}
