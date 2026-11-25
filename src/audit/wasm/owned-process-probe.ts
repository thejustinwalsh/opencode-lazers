import { spawn } from "node:child_process"

const scenario = process.argv[2]

if (scenario === "success") {
  process.stdout.write("progress: started\n")
  process.stderr.write("diagnostic: started\n")
  setTimeout(() => {
    process.stdout.write("progress: finished\n")
    process.exit(0)
  }, 150)
} else if (scenario === "nonzero") {
  process.stdout.write("stdout diagnostic\n")
  process.stderr.write("stderr diagnostic\n")
  process.exit(17)
} else if (scenario === "large") {
  process.stdout.write(`${"x".repeat(160 * 1024)}\n`)
  process.stderr.write(`${"y".repeat(160 * 1024)}\n`)
  process.exit(0)
} else if (scenario === "descendant" || scenario === "orphan") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.stdout.write('descendant alive\\\\n'); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  )
  process.stdout.write(`descendant:${descendant.pid}\n`)
  if (scenario === "orphan") process.exit(0)
  setInterval(() => {}, 1000)
} else if (scenario === "hang") {
  process.stdout.write("hang started\n")
  setInterval(() => {}, 1000)
} else {
  throw new Error(`unknown owned-process probe scenario: ${scenario}`)
}
