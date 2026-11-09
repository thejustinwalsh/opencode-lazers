# Structural audit guidance

Adapted from [untangle-codebase](https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md).
Its strongest contribution is a structural lens beyond static analyzer output.
Architect scopes coherent work; Auditor investigates and simplifies; Architect
reviews behavior. The existing runner and durable audit history remain the path.

The agent definitions now include change boundaries, shared causes and a short
decision log. No new role, runtime gate or mandatory skill is introduced.
Structural findings not produced by Fallow belong in the task-linked repository
report; do not invent Fallow finding IDs. Analyzer findings retain their existing
SQLite assessments and run links.

Do not adopt an unlimited cleanup loop, automatic removal of retries or a
zero-finding target. Success remains useful simplification with working behavior.
Published effectiveness claims have not been independently validated here.

Reliability failures require diagnosis and proportional repair. A new restriction
is not the default remedy; remove unnecessary restrictions when they cause the
failure. This guidance is not another acceptance condition.
