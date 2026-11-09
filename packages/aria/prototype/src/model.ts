/**
 * Domain model of the Aria prototype.
 *
 * These are presentation types only. Nothing here reads the DSH session, agent,
 * memory, or job services: every value the prototype renders comes from the
 * fixture module, and every mutation lives in local component state. The types
 * name the information the interface has to be able to show, so a later host
 * binding can map real data onto them without redesigning a screen.
 */

/** Lifecycle of a mission, which is the prototype's unit of work. */
export type MissionStatus = 'running' | 'awaiting' | 'review' | 'complete' | 'failed' | 'paused'

/** Lifecycle of one execution step inside a mission. */
export type StepStatus = 'complete' | 'running' | 'pending' | 'failed' | 'skipped'

/** Whether an agent can take new work. */
export type AgentAvailability = 'available' | 'engaged' | 'restricted' | 'offline'

/** One step of a mission's execution plan. */
export interface MissionStep {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly status: StepStatus
  /** Agent id that owns the step, or null while the plan is unassigned. */
  readonly agentId: string | null
  /** Wall-clock label, already localized for display. */
  readonly timing: string
}

/** One event on a mission's execution log. */
export interface MissionEvent {
  readonly id: string
  /** ISO-8601 instant; the interface formats it for the active locale. */
  readonly at: string
  readonly kind: 'plan' | 'action' | 'approval' | 'artifact' | 'warning' | 'failure'
  readonly summary: string
  readonly actorId: string | null
}

/** A file or record a mission produced. */
export interface MissionArtifact {
  readonly id: string
  readonly name: string
  readonly kind: 'report' | 'dataset' | 'memo' | 'code' | 'brief'
  readonly meta: string
}

/** One mission. */
export interface Mission {
  readonly id: string
  /** Short human title, e.g. "Q4 supply review". */
  readonly title: string
  /** One-sentence objective, shown in lists and at the top of the detail view. */
  readonly objective: string
  /** Longer statement of intent, shown only in the detail view. */
  readonly brief: string
  readonly status: MissionStatus
  /** Completion in whole percent. */
  readonly progress: number
  /** ISO-8601 instants. */
  readonly createdAt: string
  readonly updatedAt: string
  /** Agent ids participating, in the order the plan assigns them. */
  readonly agentIds: readonly string[]
  readonly steps: readonly MissionStep[]
  readonly events: readonly MissionEvent[]
  readonly artifacts: readonly MissionArtifact[]
  /** Free-text ownership label, e.g. "Strategy desk". */
  readonly desk: string
}

/** One capability an agent offers, with its own maturity. */
export interface AgentCapability {
  readonly name: string
  readonly note: string
  readonly level: 'core' | 'supporting' | 'experimental'
}

/** One agent. */
export interface Agent {
  readonly id: string
  readonly name: string
  readonly role: string
  /** One-sentence description of what the agent is for. */
  readonly summary: string
  readonly availability: AgentAvailability
  /** Reasoning model the agent runs on, e.g. "dsh-reasoner". */
  readonly model: string
  /** Context window, already formatted, e.g. "200K". */
  readonly context: string
  readonly capabilities: readonly AgentCapability[]
  readonly assignmentIds: readonly string[]
  readonly lastActiveAt: string
  /** Successful runs over the last thirty days. */
  readonly runsLast30Days: number
  /** Mean run duration, already formatted, e.g. "4m 12s". */
  readonly meanRuntime: string
  /** Whether the agent holds write privileges on the workspace. */
  readonly canWrite: boolean
}

/** A knowledge collection grouping related resources. */
export interface KnowledgeCollection {
  readonly id: string
  readonly name: string
  readonly summary: string
  /** Number of resources in the collection. */
  readonly count: number
  /** Whether the collection is indexed and available to missions. */
  readonly indexed: boolean
  /** Data classification, e.g. "Internal", "Confidential". */
  readonly clearance: string
  readonly updatedAt: string
}

/** One knowledge resource. */
export interface KnowledgeResource {
  readonly id: string
  readonly collectionId: string
  readonly title: string
  readonly source: string
  readonly format: 'pdf' | 'sheet' | 'doc' | 'note' | 'web' | 'dataset'
  readonly updatedAt: string
  /** Already-formatted size, e.g. "2.4 MB". */
  readonly size: string
  /** Distinct missions that cited the resource. */
  readonly citations: number
  readonly tags: readonly string[]
}

/** One activity entry, the union view over mission and agent events. */
export interface ActivityEntry {
  readonly id: string
  readonly at: string
  readonly scope: 'mission' | 'agent' | 'system'
  readonly outcome: 'success' | 'failure' | 'attention' | 'info'
  readonly title: string
  readonly detail: string
  readonly missionId: string | null
  readonly agentId: string | null
}

/** A single operational indicator on the dashboard. */
export interface OperationalIndicator {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly detail: string
  /** Already-formatted change since the previous period, e.g. "+2 today". */
  readonly delta: string | null
  readonly tone: 'neutral' | 'accent' | 'warn'
}

/** System health shown in the workspace header. */
export interface SystemStatus {
  readonly state: 'nominal' | 'degraded' | 'maintenance'
  readonly label: string
  readonly detail: string
  /** Already-formatted share of the scheduler's capacity in use. */
  readonly load: string
  readonly queue: number
}

/** Everything the prototype needs to render a session of work. */
export interface Workspace {
  readonly name: string
  readonly operator: string
  /** Operator initials for the header avatar. */
  readonly operatorInitials: string
  readonly status: SystemStatus
  readonly missions: readonly Mission[]
  readonly agents: readonly Agent[]
  readonly collections: readonly KnowledgeCollection[]
  readonly resources: readonly KnowledgeResource[]
  readonly activity: readonly ActivityEntry[]
  readonly indicators: readonly OperationalIndicator[]
}

/** The status a newly submitted demonstration mission starts in. */
export const NEW_MISSION_STATUS: MissionStatus = 'running'

/** Human label and palette tone for each mission status. */
export const MISSION_STATUS_LABEL: Readonly<Record<MissionStatus, string>> = {
  running: 'mission.status.running',
  awaiting: 'mission.status.awaiting',
  review: 'mission.status.review',
  complete: 'mission.status.complete',
  failed: 'mission.status.failed',
  paused: 'mission.status.paused',
}

/** Human label for each agent availability. */
export const AGENT_AVAILABILITY_LABEL: Readonly<Record<AgentAvailability, string>> = {
  available: 'agent.availability.available',
  engaged: 'agent.availability.engaged',
  restricted: 'agent.availability.restricted',
  offline: 'agent.availability.offline',
}
