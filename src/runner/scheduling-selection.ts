import { scopePatternsConflict } from "./artifacts.ts"

export type SchedulingReservation = {
  shared: boolean
  scopes: string[]
  taskID?: string
}

export type SchedulingCandidate = {
  taskID: string
  scopes: string[]
}

export type SchedulingCandidateHold = {
  reason: string
  reservationTaskIDs: string[]
}

export type SchedulingSelection = {
  selectedTaskIDs: string[]
  holds: Map<string, SchedulingCandidateHold>
}

/** The runtime and the read-only Tasks projection share this exact resource/order rule. */
export function selectSchedulingCandidates(
  workspaceMode: "shared" | "isolated",
  candidates: readonly SchedulingCandidate[],
  initialReservations: readonly SchedulingReservation[],
): SchedulingSelection {
  const reservations = [...initialReservations]
  const selectedTaskIDs: string[] = []
  const holds = new Map<string, SchedulingCandidateHold>()

  if (workspaceMode === "shared") {
    if (reservations.length) {
      const reservationTaskIDs = reservations.flatMap((reservation) =>
        reservation.taskID ? [reservation.taskID] : [],
      )
      for (const candidate of candidates)
        holds.set(candidate.taskID, {
          reason: "The shared checkout is reserved by active work.",
          reservationTaskIDs,
        })
      return { selectedTaskIDs, holds }
    }
    const [first, ...remaining] = candidates
    if (first) selectedTaskIDs.push(first.taskID)
    for (const candidate of remaining)
      holds.set(candidate.taskID, {
        reason: "Shared checkouts dispatch one task at a time.",
        reservationTaskIDs: first ? [first.taskID] : [],
      })
    return { selectedTaskIDs, holds }
  }

  const shared = reservations.find((reservation) => reservation.shared)
  if (shared) {
    const reservationTaskIDs = reservations.flatMap((reservation) =>
      reservation.shared && reservation.taskID ? [reservation.taskID] : [],
    )
    for (const candidate of candidates)
      holds.set(candidate.taskID, {
        reason: "The shared checkout is reserved by active work.",
        reservationTaskIDs,
      })
    return { selectedTaskIDs, holds }
  }

  for (const candidate of candidates) {
    const conflicts = reservations.filter((reservation) =>
      scopePatternsConflict(reservation.scopes, candidate.scopes),
    )
    if (conflicts.length) {
      holds.set(candidate.taskID, {
        reason: "A conflicting write scope is reserved.",
        reservationTaskIDs: conflicts.flatMap((reservation) =>
          reservation.taskID ? [reservation.taskID] : [],
        ),
      })
      continue
    }
    selectedTaskIDs.push(candidate.taskID)
    reservations.push({ shared: false, scopes: candidate.scopes, taskID: candidate.taskID })
  }
  return { selectedTaskIDs, holds }
}
