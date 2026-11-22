const TERMINAL_CLEANUP_STATES = ["settled", "terminated"] as const
const SYNTHETIC_FALLOW_COMMAND = "lazers:fallow-audit"
const SYNTHETIC_FALLOW_STATES = ["clean", "findings", "unavailable"] as const

/**
 * SQL predicate for receipt rows which do not explicitly prove process cleanup settled.
 * Incomplete terminal receipts stay candidates so the live observer can identify a process group
 * or report uncertainty instead of trusting the parent's terminal state.
 */
export function unsettledProcessCleanupSQL(receipt: string, check: string): string {
  const topLevelCleanupSettled = `(
    json_type(${receipt}, '$.processCleanup') = 'object'
    AND json_extract(${receipt}, '$.processCleanup.state') IN ('${TERMINAL_CLEANUP_STATES.join("','")}')
    AND json_extract(${receipt}, '$.processCleanup.capability') IN ('process-group','windows-process-tree')
    AND json_type(${receipt}, '$.processCleanup.rootPID') = 'integer'
    AND json_extract(${receipt}, '$.processCleanup.rootPID') > 0
  )`
  const phasesSettled = `(
    json_type(${receipt}, '$.phases') = 'array'
    AND json_array_length(${receipt}, '$.phases') > 0
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${receipt}, '$.phases') AS phase
      WHERE CASE
        WHEN json_valid(phase.value) = 0 THEN 1
        WHEN json_type(phase.value) <> 'object' THEN 1
        WHEN json_type(phase.value, '$.processCleanup') IS NOT 'object' THEN 1
        WHEN COALESCE(json_extract(phase.value, '$.processCleanup.state'), '')
          NOT IN ('${TERMINAL_CLEANUP_STATES.join("','")}') THEN 1
        WHEN COALESCE(json_extract(phase.value, '$.processCleanup.capability'), '')
          NOT IN ('process-group','windows-process-tree') THEN 1
        WHEN json_type(phase.value, '$.processCleanup.rootPID') IS NOT 'integer' THEN 1
        WHEN json_extract(phase.value, '$.processCleanup.rootPID') <= 0 THEN 1
        ELSE 0
      END = 1
    )
  )`

  return `(
    ${receipt} IS NULL
    OR CASE
      WHEN json_valid(${receipt}) = 0 THEN 1
      WHEN json_type(${receipt}) <> 'object' THEN 1
      WHEN json_valid(${check}) = 1
        AND json_extract(${check}, '$.command') = '${SYNTHETIC_FALLOW_COMMAND}'
        THEN CASE WHEN json_extract(${receipt}, '$.fallow.status')
          IN ('${SYNTHETIC_FALLOW_STATES.join("','")}') THEN 0 ELSE 1 END
      WHEN json_type(${receipt}, '$.phases') = 'array'
        THEN CASE WHEN ${phasesSettled} THEN 0 ELSE 1 END
      WHEN ${topLevelCleanupSettled} THEN 0
      ELSE 1
    END = 1
  )`
}
