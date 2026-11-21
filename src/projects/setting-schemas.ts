import { z } from "zod"

/**
 * The one place a setting is declared: its zod schema (validates every write and every stored
 * read, and is the shape the Settings RPC returns) and its built-in default. Types, validation,
 * defaults and the RPC view are all derived from these two tables. To add a setting, whether a
 * number or a structured value such as the project profile, add one entry here:
 *
 *   profile: setting(ProfileSchema, emptyProfile)
 *
 * Values are stored as JSON text in `lazers_settings.value`, so no migration is needed. This
 * file imports only zod so the GUI bundle can share it.
 */
export type SettingDef<T extends z.ZodType = z.ZodType> = { schema: T; builtIn: z.output<T> }
const setting = <T extends z.ZodType>(schema: T, builtIn: z.output<T>): SettingDef<T> => ({
  schema,
  builtIn,
})

const count = z.int().min(1)
const amount = z.number().finite().positive()

/** Which model decides the size and agents of an ask. */
export const DecisionModelSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local") }),
  z.strictObject({
    kind: z.literal("external"),
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("architect") }),
])
export const DecisionSlicerSchema = z.enum(["windows", "whole", "pre-slice", "uncertainty"])

export const globalSettingDefs = {
  globalSlots: setting(count.nullable(), null),
  agingMs: setting(amount, 600_000),
  historyCacheMB: setting(amount, 128),
  decisionModel: setting(DecisionModelSchema, { kind: "local" as const }),
  decisionSlicer: setting(DecisionSlicerSchema, "windows" as const),
}
export const projectSettingDefs = {
  limit: setting(count.nullable(), null),
  weight: setting(amount, 1),
  spendCeilingTokens: setting(count.nullable(), null),
  planningAutoDispatch: setting(z.boolean(), true),
  /** When the owner dismissed the "no verification profile" notice, as epoch milliseconds. */
  setupDismissedAt: setting(count.nullable(), null),
}

type Values<D extends Record<string, SettingDef>> = { [K in keyof D]: z.output<D[K]["schema"]> }
export type GlobalSettings = Values<typeof globalSettingDefs>
export type ProjectSettings = Values<typeof projectSettingDefs>

const shape = <D extends Record<string, SettingDef>>(defs: D) =>
  Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, def.schema])) as {
    [K in keyof D]: D[K]["schema"]
  }
/** The Settings RPC views, derived from the declarations. */
export const GlobalSettingsView = z.strictObject(shape(globalSettingDefs))
export const ProjectSettingsView = z.strictObject(shape(projectSettingDefs))
