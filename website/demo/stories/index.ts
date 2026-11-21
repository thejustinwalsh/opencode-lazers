import type { StorySource } from "../src/story.ts"
import { reads as tasksReads } from "../src/panels/tasks-answers.ts"
import type { Read } from "../src/adapter.ts"
import { reads as radarReads } from "../src/panels/radar-answers.ts"
import { reads as trajectoryReads } from "../src/panels/trajectory-streams.ts"
import { reads as modelsReads } from "../src/panels/models-answers.ts"
import hero from "./hero.ts"
import radar from "./radar.ts"
import models from "./models.ts"
import trajectory from "./trajectory.ts"

export const stories: StorySource<never>[] = [
  hero as never,
  radar as never,
  trajectory as never,
  models as never,
]

/** The pure validator for each panel's data: every read the data answers, with its schema. */
export const readers: Record<string, (data: never) => Read[]> = {
  tasks: tasksReads as never,
  radar: radarReads as never,
  models: modelsReads as never,
  trajectory: trajectoryReads as never,
}
