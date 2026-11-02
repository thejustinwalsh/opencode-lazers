import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, join, normalize } from "node:path"
import { canonical } from "../../identity.ts"
import { ResourceRegistrationInputSchema } from "./schema.ts"
import type {
  OwnedResource,
  ResourceDescriptor,
  ResourceObservation,
  ResourceRegistrationInput,
} from "./schema.ts"

type Claim = {
  schemaVersion: 1
  coordinatorID: string
  resourceID: string
  resourceKey: string
  generation: number
}

class ResourceIdentityMismatch extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined
}

function readRegularFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size > 4_096)
      throw new Error("Expected a bounded regular ownership file")
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}

function sameClaim(value: unknown, expected: Claim): boolean {
  return value !== undefined && canonical(value) === canonical(expected)
}

/** The adapter boundary used by the durable lifecycle; implementations must report authority. */
export interface OwnedResourceAdapter {
  describe(input: ResourceRegistrationInput): ResourceDescriptor
  path(resource: OwnedResource): string
  reserve(resource: OwnedResource, coordinatorID: string): void
  observe(resource: OwnedResource, coordinatorID: string): ResourceObservation
  create(resource: OwnedResource, coordinatorID: string): void
  remove(resource: OwnedResource, coordinatorID: string): void
  release(resource: OwnedResource, coordinatorID: string): void
}

/**
 * A disposable directory fixture rooted at one existing directory. The root's
 * canonical path and a durable sidecar claim make aliases and independent SQLite
 * coordinators fail closed before either can create the same fixture.
 */
export class FilesystemFixtureAdapter implements OwnedResourceAdapter {
  readonly root: string
  private readonly rootDevice: number
  private readonly rootInode: number

  constructor(rootDirectory: string) {
    const root = realpathSync(rootDirectory)
    const stats = lstatSync(root)
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error("Filesystem fixture root must resolve to a real directory")
    this.root = root
    this.rootDevice = stats.dev
    this.rootInode = stats.ino
  }

  describe(input: ResourceRegistrationInput): ResourceDescriptor {
    const parsed = ResourceRegistrationInputSchema.parse(input)
    if (isAbsolute(parsed.name) || parsed.name.includes("/") || parsed.name.includes("\\"))
      throw new Error("Fixture names must be a single safe path segment")
    if (normalize(parsed.name) !== parsed.name || parsed.name === "." || parsed.name === "..")
      throw new Error("Unsafe filesystem fixture name")
    const foldedName = parsed.name.normalize("NFC").toLowerCase()
    return {
      ...parsed,
      // Conservative case folding prevents aliases on case-insensitive volumes.
      resourceKey: `filesystem:${this.root.normalize("NFC").toLowerCase()}/${foldedName}`,
    }
  }

  path(resource: OwnedResource): string {
    this.assertResourceIdentity(resource)
    this.assertRoot()
    return join(this.root, resource.name)
  }

  reserve(resource: OwnedResource, coordinatorID: string): void {
    this.assertResourceIdentity(resource)
    this.assertRoot()
    const claim = this.expectedClaim(resource, coordinatorID)
    const path = this.claimPath(resource)
    try {
      writeFileSync(path, JSON.stringify(claim), { flag: "wx", mode: 0o600 })
      return
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }

    const existing = this.readClaim(path)
    if (!existing || !sameClaim(existing, claim))
      throw new Error("Filesystem resource is reserved by another owner or coordinator")
  }

  observe(resource: OwnedResource, coordinatorID: string): ResourceObservation {
    try {
      this.assertResourceIdentity(resource)
      this.assertRoot()
      const path = this.path(resource)
      let stats: ReturnType<typeof lstatSync>
      try {
        stats = lstatSync(path)
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          return { state: "absent", authoritative: true, reason: "Fixture path is absent" }
        return {
          state: "unknown",
          authoritative: false,
          reason: "Fixture path could not be observed",
        }
      }
      if (stats.isSymbolicLink() || !stats.isDirectory())
        return {
          state: "foreign",
          authoritative: true,
          reason: "Fixture path is not an owned directory",
        }

      const markerPath = join(path, ".lazers-owner")
      const expected = this.expectedClaim(resource, coordinatorID)
      let marker: unknown
      try {
        marker = JSON.parse(readRegularFile(markerPath))
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          return {
            state: "foreign",
            authoritative: true,
            reason: "Fixture ownership marker is absent",
          }
        if (error instanceof SyntaxError)
          return {
            state: "foreign",
            authoritative: true,
            reason: "Fixture ownership marker is invalid",
          }
        return {
          state: "unknown",
          authoritative: false,
          reason: "Fixture ownership could not be read safely",
        }
      }
      if (!sameClaim(marker, expected))
        return { state: "foreign", authoritative: true, reason: "Fixture belongs to another owner" }

      const entries = readdirSync(path).sort()
      if (entries.some((entry) => entry !== ".lazers-owner" && entry !== "fixture.txt"))
        return {
          state: "foreign",
          authoritative: true,
          reason: "Fixture directory contains foreign entries",
        }
      if (entries.includes("fixture.txt")) {
        const contentStats = lstatSync(join(path, "fixture.txt"))
        if (contentStats.isSymbolicLink() || !contentStats.isFile())
          return {
            state: "foreign",
            authoritative: true,
            reason: "Fixture content is not a regular file",
          }
      }
      return { state: "owned", authoritative: true }
    } catch (error) {
      if (error instanceof ResourceIdentityMismatch)
        return {
          state: "unknown",
          authoritative: false,
          reason: "Persisted resource identity does not match the configured filesystem root",
        }
      return {
        state: "unknown",
        authoritative: false,
        reason: "Filesystem observation was inconclusive",
      }
    }
  }

  create(resource: OwnedResource, coordinatorID: string): void {
    const current = this.observe(resource, coordinatorID)
    if (current.state === "owned" && current.authoritative) return
    if (current.state !== "absent" || !current.authoritative)
      throw new Error(current.reason ?? "Fixture path is not safely available")

    const path = this.path(resource)
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const afterRace = this.observe(resource, coordinatorID)
        if (afterRace.state === "owned" && afterRace.authoritative) return
      }
      throw error
    }
    writeFileSync(
      join(path, ".lazers-owner"),
      JSON.stringify(this.expectedClaim(resource, coordinatorID)),
      { flag: "wx", mode: 0o600 },
    )
    writeFileSync(join(path, "fixture.txt"), resource.contents, { flag: "wx", mode: 0o600 })
  }

  remove(resource: OwnedResource, coordinatorID: string): void {
    const observation = this.observe(resource, coordinatorID)
    if (observation.state !== "owned" || !observation.authoritative)
      throw new Error(observation.reason ?? "Refusing to remove an unowned fixture")
    const path = this.path(resource)
    const entries = readdirSync(path).sort()
    if (entries.some((entry) => entry !== ".lazers-owner" && entry !== "fixture.txt"))
      throw new Error("Refusing to remove fixture containing foreign entries")
    const marker = () => {
      const current = this.observe(resource, coordinatorID)
      if (current.state !== "owned" || !current.authoritative)
        throw new Error(current.reason ?? "Fixture ownership changed during teardown")
    }
    if (entries.includes("fixture.txt")) {
      marker()
      const content = join(path, "fixture.txt")
      const stats = lstatSync(content)
      if (stats.isSymbolicLink() || !stats.isFile())
        throw new Error("Refusing to remove a non-regular fixture entry")
      unlinkSync(content)
    }
    marker()
    const markerPath = join(path, ".lazers-owner")
    const markerStats = lstatSync(markerPath)
    if (markerStats.isSymbolicLink() || !markerStats.isFile())
      throw new Error("Refusing to remove an invalid ownership marker")
    unlinkSync(markerPath)
    rmdirSync(path)
  }

  release(resource: OwnedResource, coordinatorID: string): void {
    this.assertResourceIdentity(resource)
    this.assertRoot()
    const path = this.claimPath(resource)
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(path)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new Error("Refusing to release a foreign filesystem reservation")
    const expected = this.expectedClaim(resource, coordinatorID)
    if (!sameClaim(this.readClaim(path), expected))
      throw new Error("Filesystem reservation is owned by another coordinator")
    this.assertRoot()
    const currentStats = lstatSync(path)
    if (
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino ||
      !sameClaim(this.readClaim(path), expected)
    )
      throw new Error("Filesystem reservation changed during release")
    unlinkSync(path)
  }

  private expectedClaim(resource: OwnedResource, coordinatorID: string): Claim {
    return {
      schemaVersion: 1,
      coordinatorID,
      resourceID: resource.resourceID,
      resourceKey: resource.resourceKey,
      generation: resource.generation,
    }
  }

  private claimPath(resource: OwnedResource): string {
    this.assertResourceIdentity(resource)
    const hash = createHash("sha256").update(resource.resourceKey).digest("hex")
    return join(this.root, `.lazers-resource-claim-${hash}`)
  }

  private assertResourceIdentity(resource: OwnedResource): void {
    const parsed = ResourceRegistrationInputSchema.parse({
      requestID: resource.requestID,
      generation: resource.generation,
      name: resource.name,
      contents: resource.contents,
    })
    if (this.resourceKeyFor(parsed.name) !== resource.resourceKey)
      throw new ResourceIdentityMismatch(
        "Persisted resource identity belongs to another fixture root",
      )
  }

  private resourceKeyFor(name: string): string {
    const foldedName = name.normalize("NFC").toLowerCase()
    return `filesystem:${this.root.normalize("NFC").toLowerCase()}/${foldedName}`
  }

  private readClaim(path: string): unknown | undefined {
    try {
      const stats = lstatSync(path)
      if (stats.isSymbolicLink() || !stats.isFile()) return undefined
      return JSON.parse(readRegularFile(path))
    } catch {
      return undefined
    }
  }

  private assertRoot(): void {
    const actual = realpathSync(this.root)
    const stats = lstatSync(actual)
    if (
      actual !== this.root ||
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== this.rootDevice ||
      stats.ino !== this.rootInode
    )
      throw new Error("Filesystem fixture root changed after adapter initialization")
  }
}
