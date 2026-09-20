import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ClientToolError, defineClientTool } from "./index.ts"

interface Deployment {
  id: string
  site: string
  environment: "preview" | "staging" | "production"
  region: "automatic" | "Europe" | "North America"
  operation: "deploy" | "teardown"
  stage: number
  confirmed: boolean
  paused: boolean
  cancelled: boolean
  deployed: boolean
  revision: number
  readyAt: number
  pausedRemaining: number
  updatedAt: number
}
const deployments = new Map<string, Deployment>()
const deployStages = ["Building site", "Preparing upload", "Uploading assets", "Rolling out to Cloudflare", "Checking site health", "Deployment completed"]
const teardownStages = ["Stopping traffic", "Removing deployed assets", "Verifying removal", "Deployment removed"]
const deployDurations = [5_000, 5_000, 5_000, 12_000, 5_000, 0]
const teardownDurations = [3_000, 5_000, 3_000, 0]
const stages = (job: Deployment) => job.operation === "deploy" ? deployStages : teardownStages
const durations = (job: Deployment) => job.operation === "deploy" ? deployDurations : teardownDurations
const ended = (job: Deployment) => job.stage === stages(job).length - 1
const needsInput = (job: Deployment) => job.operation === "deploy" && job.stage === 1 && !job.confirmed
const duration = (job: Deployment) => durations(job)[job.stage] ?? 0
const setStage = (job: Deployment, stage: number) => {
  job.stage = stage
  job.readyAt = Date.now() + duration(job)
  job.pausedRemaining = duration(job)
  if (ended(job)) job.deployed = job.operation === "deploy"
}
const snapshot = (job: Deployment) => {
  const blocked = job.paused || needsInput(job)
  const terminal = job.cancelled || ended(job)
  const stageRemaining = terminal ? 0 : blocked ? job.pausedRemaining : Math.max(0, job.readyAt - Date.now())
  const remainingWork = terminal ? 0 : stageRemaining + durations(job).slice(job.stage + 1).reduce((sum, ms) => sum + ms, 0)
  const estimatedRemaining = blocked && !terminal ? null : remainingWork
  const suggestedCheckIn = terminal || blocked ? null : Math.max(1_000, Math.min(stageRemaining || 1_000, job.operation === "deploy" && job.stage === 3 ? 10_000 : 5_000))
  return {
    simulation: true, deployment_id: job.id, site: job.site, environment: job.environment, region: job.region, operation: job.operation, deployed: job.deployed,
    status: job.cancelled ? "cancelled" : job.paused ? "paused" : needsInput(job) ? "awaiting_input" : ended(job) ? "completed" : "running",
    stage: needsInput(job) ? "Build passed; awaiting rollout preferences" : stages(job)[job.stage],
    progress_percent: Math.round(job.stage * 100 / (stages(job).length - 1)),
    estimated_remaining_ms: estimatedRemaining,
    estimated_completion_at: estimatedRemaining === null ? null : Date.now() + estimatedRemaining,
    remaining_work_ms: remainingWork,
    stage_estimated_remaining_ms: blocked ? null : stageRemaining,
    suggested_check_in_ms: suggestedCheckIn,
    estimate_basis: "Simulated work time; excludes time waiting for user input or paused. Stages advance when polled.",
    ...(needsInput(job) ? { question: `The build passed. Should I deploy ${job.site} to ${job.environment}, and should I use automatic routing, Europe, or North America?`, instruction: "Ask the user this question through send_update_to_router, then wait_for_router. Do not confirm on their behalf. Apply their answer with update_deployment before continuing." } : {}),
    ...(!terminal && !blocked ? { next_poll: { tool: "get_deployment_status", arguments: { deployment_id: job.id } }, message: "Operation is incomplete. Use the timing estimates to plan check-ins, then continue polling to completion." } : {}),
    ...(ended(job) ? job.operation === "teardown" ? { message: "Simulation teardown completed. The simulated deployment was removed; no real infrastructure was changed." } : { preview_url: `https://${job.site.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site"}-${job.environment}.example.com`, message: "Simulation complete. This example URL is illustrative; no site was published." } : {}),
  }
}
const findDeployment = (id: string) => Effect.gen(function* () {
  const job = deployments.get(id)
  if (!job || Date.now() - job.updatedAt > 30 * 60_000) return yield* new ClientToolError({ tool: "deployment", message: "Simulated deployment not found or expired. Start a new deployment." })
  return job
})
const deploySite = defineClientTool({
  name: "deploy_site", example: "Deploy the shopping cart site to Cloudflare. Keep me updated and ask me about rollout settings.",
  description: "Start a SIMULATED deployment; no real infrastructure changes. Results include estimated_remaining_ms and suggested_check_in_ms for contextual progress updates. Poll get_deployment_status while running; ask the returned question and wait for the user at awaiting_input. Apply their answer with update_deployment. Clearly describe this as a simulation.",
  inputSchema: Schema.Struct({ site: Schema.String }),
  run: ({ site }) => Effect.gen(function* () {
    if (!site.trim() || site.length > 120) return yield* new ClientToolError({ tool: "deploy_site", message: "Provide a site name between 1 and 120 characters." })
    for (const [id, job] of deployments) if (Date.now() - job.updatedAt > 30 * 60_000) deployments.delete(id)
    const existing = [...deployments.values()].find(job => job.site.toLowerCase() === site.trim().toLowerCase() && !job.cancelled && (!ended(job) || job.deployed))
    if (existing) return snapshot(existing)
    if (deployments.size >= 32) return yield* new ClientToolError({ tool: "deploy_site", message: "Simulation capacity reached. Reload the voice test to reset deployments." })
    const now = Date.now()
    const job: Deployment = { id: crypto.randomUUID(), site: site.trim(), environment: "preview", region: "automatic", operation: "deploy", stage: 0, confirmed: false, paused: false, cancelled: false, deployed: false, revision: 0, readyAt: now + 5_000, pausedRemaining: 5_000, updatedAt: now }
    deployments.set(job.id, job)
    return snapshot(job)
  })
})
const deploymentStatus = defineClientTool({
  name: "get_deployment_status", example: "How is the deployment or teardown going?",
  description: "Wait up to five seconds for progress on a simulated deployment or teardown. Results carry estimates for the current stage and remaining work. Continue polling while running, but relay only useful progress at contextually chosen intervals. A rollout stage intentionally takes longer. Stop at completed/cancelled; wait for user input at awaiting_input/paused. No real infrastructure changes.",
  inputSchema: Schema.Struct({ deployment_id: Schema.String }),
  run: ({ deployment_id }) => Effect.gen(function* () {
    const job = yield* findDeployment(deployment_id)
    const revision = job.revision
    const stage = job.stage
    if (!job.cancelled && !job.paused && !ended(job) && !needsInput(job)) {
      yield* Effect.sleep(Math.min(5_000, Math.max(0, job.readyAt - Date.now())))
      if (!job.cancelled && !job.paused && job.revision === revision && job.stage === stage && Date.now() >= job.readyAt) setStage(job, stage + 1)
    }
    job.updatedAt = Date.now()
    return snapshot(job)
  })
})
const updateDeployment = defineClientTool({
  name: "update_deployment", example: "Make that staging in Europe. Pause the rollout—actually, resume it.",
  description: "Apply user-directed environment/region changes or confirm, pause, resume, cancel to the simulation. Confirm only after the rollout question is answered; resume does not confirm. Setting changes restart upload preparation. Pausing makes completion time unknown until resumed. To remove a deployment, use teardown_deployment; cancellation only stops ongoing work.",
  inputSchema: Schema.Struct({ deployment_id: Schema.String, environment: Schema.optional(Schema.Literals(["preview", "staging", "production"])), region: Schema.optional(Schema.Literals(["automatic", "Europe", "North America"])), action: Schema.optional(Schema.Literals(["confirm", "pause", "resume", "cancel"])) }),
  run: ({ deployment_id, environment, region, action }) => Effect.gen(function* () {
    const job = yield* findDeployment(deployment_id)
    if (job.cancelled || ended(job)) return yield* new ClientToolError({ tool: "update_deployment", message: "This simulation has ended. Start a new deployment or use teardown_deployment." })
    if (job.operation === "teardown" && (environment !== undefined || region !== undefined || action === "confirm")) return yield* new ClientToolError({ tool: "update_deployment", message: "A teardown has no rollout preferences. Pause, resume, or cancel it instead." })
    const changed = (environment !== undefined && environment !== job.environment) || (region !== undefined && region !== job.region)
    if (environment !== undefined) job.environment = environment
    if (region !== undefined) job.region = region
    if (changed && job.stage > 1) setStage(job, 1)
    if (action === "confirm" && !job.confirmed) { job.confirmed = true; job.readyAt = Date.now() + duration(job) }
    if (action === "pause" && !job.paused) { job.pausedRemaining = Math.max(0, job.readyAt - Date.now()); job.paused = true }
    if (action === "resume" && job.paused) { job.readyAt = Date.now() + job.pausedRemaining; job.paused = false }
    if (action === "cancel") job.cancelled = true
    if (changed || action) job.revision++
    job.updatedAt = Date.now()
    return snapshot(job)
  })
})
const teardownDeployment = defineClientTool({
  name: "teardown_deployment", example: "Tear down the shopping cart deployment and keep me posted.",
  description: "Start a SIMULATED teardown of an active, cancelled, or completed deployment. Stops the previous rollout and removes the simulated deployment through timed stages. No real site or infrastructure is deleted. Repeated requests reuse the same teardown. Poll get_deployment_status to completion and use its estimates to plan updates.",
  inputSchema: Schema.Struct({ deployment_id: Schema.String }),
  run: ({ deployment_id }) => Effect.gen(function* () {
    const job = yield* findDeployment(deployment_id)
    if (job.operation === "teardown" && !job.cancelled) return snapshot(job)
    job.operation = "teardown"
    job.paused = false
    job.cancelled = false
    job.revision++
    setStage(job, 0)
    job.updatedAt = Date.now()
    return snapshot(job)
  })
})
export const deploymentTools = [deploySite, deploymentStatus, updateDeployment, teardownDeployment]
