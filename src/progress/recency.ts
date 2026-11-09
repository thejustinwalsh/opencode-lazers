/** Derived index value, preserving the existing native-observation ordering. */
export function progressRecencySQL(alias: "g" | "NEW" | "runner_progress") {
  return `max(${alias}.at, COALESCE((
    SELECT MAX(CASE WHEN observation.type='object' THEN
      CASE WHEN json_type(observation.value,'$.at') IN ('integer','real') THEN
        CASE WHEN json_extract(observation.value,'$.at')
          BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
          THEN json_extract(observation.value,'$.at') END
      END
    END)
    FROM json_each(CASE WHEN json_valid(${alias}.payload) THEN
      CASE WHEN json_type(${alias}.payload,'$.observations')='array'
        THEN ${alias}.payload ELSE '{"observations":[]}' END
      ELSE '{"observations":[]}' END, '$.observations') AS observation
  ), ${alias}.at))`
}
