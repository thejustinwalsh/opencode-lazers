#!/bin/sh
# The standing gate: verify, then the test suite in chunks, each its own process.
# One process for the whole repository runs out of memory (Fallow WASM instances accumulate),
# and bare `bun test` uses a 5 s per-test default for all but the first file.
set -u
cd "$(dirname "$0")/.."
T="--timeout 120000"
fail=0
run() { name=$1; shift; printf '== %s\n' "$name"; if "$@" > "/tmp/lazers-gate-$name.log" 2>&1; then :; else fail=1; fi; grep -E '^ *[0-9]+ (pass|fail|errors?)$|^Ran [0-9]+ tests|^\(fail\)' "/tmp/lazers-gate-$name.log" | head -40; }
run verify bun run verify
run runtime sh -c "bun test $T \$(find src/runner -maxdepth 1 -name 'runtime*.test.ts' | sort)"
run runner sh -c "bun test $T \$(find src/runner -name '*.test.ts' -o -name '*.test.tsx' | grep -v -E '^src/runner/runtime(-[a-z-]+)?\.test\.ts\$' | sort)"
run audit sh -c "bun test $T \$(find src/audit -name '*.test.ts' | grep -v 'fallow-memory.test.ts' | sort)"
# Measures the process's resident memory, so it needs a process of its own.
run audit-memory bun test $T src/audit/wasm/fallow-memory.test.ts
run src sh -c "bun test $T \$(find src -name '*.test.ts' -o -name '*.test.tsx' | grep -v -e '^src/runner/' -e '^src/audit/' | sort)"
run test-scripts bun test $T ./test/ ./scripts/
run website sh -c "cd website && bun test $T demo/test test"
[ "$fail" = 0 ] && echo "GATE: pass" || echo "GATE: FAIL"
exit $fail
