/**
 * Demonstration data for the Aria prototype.
 *
 * Every value below is invented for visual review. The module is the single
 * seam between the screens and the data: no screen reaches a DSH service, an
 * HTTP endpoint, or a model provider, and nothing in the application imports
 * this module outside the prototype package. Replacing it with a host binding
 * is the whole integration step.
 *
 * The instants are fixed offsets from a reference moment rather than
 * `Date.now()`, so screenshots and interaction tests are stable; the interface
 * formats them relative to the moment the prototype mounts.
 */

import type { ActivityEntry, Agent, KnowledgeCollection, KnowledgeResource, Mission, Workspace } from './model.ts'

/** Reference instant the relative timestamps below are measured from. */
export const DEMO_REFERENCE = '2026-11-09T09:40:00.000Z'

/**
 * Shift an ISO instant by a whole number of minutes.
 * @param base - ISO-8601 instant to offset.
 * @param minutes - minutes to subtract (negative values add).
 * @returns the offset instant as an ISO-8601 string.
 */
function minutesAgo(base: string, minutes: number): string {
  return new Date(Date.parse(base) - minutes * 60_000).toISOString()
}

const HOUR = 60
const DAY = 24 * HOUR

const AGENTS: readonly Agent[] = [
  {
    id: 'agent-atlas',
    name: 'Atlas',
    role: 'Mission planner',
    summary: 'Decomposes an objective into an ordered execution plan and keeps the plan honest as evidence arrives.',
    availability: 'engaged',
    model: 'dsh-reasoner',
    context: '200K',
    capabilities: [
      { name: 'Plan decomposition', note: 'Turns an objective into steps with explicit acceptance criteria.', level: 'core' },
      { name: 'Risk framing', note: 'Names the assumptions a plan depends on before work starts.', level: 'core' },
      { name: 'Replanning', note: 'Rewrites the remaining steps when a dependency fails.', level: 'supporting' },
    ],
    assignmentIds: ['mis-q4-supply', 'mis-vendor-diligence'],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 2),
    runsLast30Days: 128,
    meanRuntime: '1m 40s',
    canWrite: false,
  },
  {
    id: 'agent-vector',
    name: 'Vector',
    role: 'Retrieval analyst',
    summary: 'Searches the knowledge collections, reconciles conflicting sources, and cites every claim it returns.',
    availability: 'available',
    model: 'dsh-retriever',
    context: '1M',
    capabilities: [
      { name: 'Hybrid retrieval', note: 'Combines lexical and semantic search across collections.', level: 'core' },
      { name: 'Source reconciliation', note: 'Flags documents that disagree and reports the discrepancy.', level: 'core' },
      { name: 'Citation binding', note: 'Attaches each sentence to the passage it came from.', level: 'supporting' },
    ],
    assignmentIds: ['mis-q4-supply'],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 6),
    runsLast30Days: 341,
    meanRuntime: '48s',
    canWrite: false,
  },
  {
    id: 'agent-ledger',
    name: 'Ledger',
    role: 'Quantitative analyst',
    summary: 'Runs structured analysis over spreadsheets and datasets, and keeps a reproducible trail for every figure.',
    availability: 'engaged',
    model: 'dsh-reasoner',
    context: '200K',
    capabilities: [
      { name: 'Tabular analysis', note: 'Aggregates and reconciles sheet data with explicit filters.', level: 'core' },
      { name: 'Scenario modelling', note: 'Computes low, base, and high cases from stated drivers.', level: 'core' },
      { name: 'Anomaly review', note: 'Surfaces rows that break the expected distribution.', level: 'experimental' },
    ],
    assignmentIds: ['mis-q4-supply', 'mis-margin-audit'],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 14),
    runsLast30Days: 96,
    meanRuntime: '3m 05s',
    canWrite: true,
  },
  {
    id: 'agent-quill',
    name: 'Quill',
    role: 'Reporting agent',
    summary: 'Composes decision memos and status briefs from the mission record, preserving the plan’s structure.',
    availability: 'available',
    model: 'dsh-writer',
    context: '128K',
    capabilities: [
      { name: 'Decision memos', note: 'Writes the recommendation, the evidence, and the open questions.', level: 'core' },
      { name: 'Status briefs', note: 'Condenses a mission’s log into a one-page update.', level: 'core' },
      { name: 'Tone control', note: 'Matches the register of the desk that owns the mission.', level: 'supporting' },
    ],
    assignmentIds: ['mis-vendor-diligence'],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 38),
    runsLast30Days: 212,
    meanRuntime: '1m 12s',
    canWrite: true,
  },
  {
    id: 'agent-sentry',
    name: 'Sentry',
    role: 'Verification agent',
    summary: 'Checks completed work against its acceptance criteria and blocks delivery when a criterion is unmet.',
    availability: 'restricted',
    model: 'dsh-verifier',
    context: '64K',
    capabilities: [
      { name: 'Criteria checking', note: 'Evaluates each acceptance criterion against the artifact.', level: 'core' },
      { name: 'Policy review', note: 'Confirms the mission stayed inside its permission envelope.', level: 'core' },
      { name: 'Approval routing', note: 'Sends the mission to the operator who owns the decision.', level: 'supporting' },
    ],
    assignmentIds: ['mis-margin-audit'],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 55),
    runsLast30Days: 74,
    meanRuntime: '22s',
    canWrite: false,
  },
  {
    id: 'agent-hermes',
    name: 'Hermes',
    role: 'Integration agent',
    summary: 'Exchanges records with the desk’s connected systems and reports every write it performs.',
    availability: 'offline',
    model: 'dsh-reasoner',
    context: '200K',
    capabilities: [
      { name: 'Record sync', note: 'Pushes approved artifacts into the connected ledger.', level: 'core' },
      { name: 'Schema mapping', note: 'Maps mission fields onto a remote record layout.', level: 'supporting' },
      { name: 'Retry policy', note: 'Replays a failed write with exponential backoff.', level: 'experimental' },
    ],
    assignmentIds: [],
    lastActiveAt: minutesAgo(DEMO_REFERENCE, 3 * DAY),
    runsLast30Days: 41,
    meanRuntime: '9s',
    canWrite: true,
  },
]

const MISSIONS: readonly Mission[] = [
  {
    id: 'mis-q4-supply',
    title: 'Q4 supply review',
    objective: 'Decide the Q4 replenishment plan for the northern distribution network.',
    brief: 'The northern network carries two weeks less cover than the southern network going into the quarter. The desk needs a recommended replenishment plan, a sensitivity band on the two drivers that matter, and an explicit list of what the plan assumes about supplier lead times.',
    status: 'running',
    progress: 62,
    createdAt: minutesAgo(DEMO_REFERENCE, 3 * HOUR + 20),
    updatedAt: minutesAgo(DEMO_REFERENCE, 2),
    agentIds: ['agent-atlas', 'agent-vector', 'agent-ledger'],
    desk: 'Operations desk',
    steps: [
      { id: 'st-1', title: 'Scope the decision', detail: 'Restated the objective, named the two decision variables, and fixed the planning horizon at thirteen weeks.', status: 'complete', agentId: 'agent-atlas', timing: '3m 10s' },
      { id: 'st-2', title: 'Collect demand history', detail: 'Pulled forty-eight weeks of shipment data and reconciled three missing weeks against the warehouse ledger.', status: 'complete', agentId: 'agent-vector', timing: '2m 44s' },
      { id: 'st-3', title: 'Model replenishment scenarios', detail: 'Computing low, base, and high cases across four suppliers with lead times drawn from the contract register.', status: 'running', agentId: 'agent-ledger', timing: '4m 02s' },
      { id: 'st-4', title: 'Cross-check supplier capacity', detail: 'Verify each scenario against the capacity commitments in the supplier agreements.', status: 'pending', agentId: 'agent-vector', timing: '—' },
      { id: 'st-5', title: 'Draft the decision memo', detail: 'Write the recommendation, the sensitivity band, and the assumptions the desk must accept.', status: 'pending', agentId: null, timing: '—' },
      { id: 'st-6', title: 'Verification', detail: 'Check the memo against the mission’s acceptance criteria before delivery.', status: 'pending', agentId: 'agent-sentry', timing: '—' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, 3 * HOUR + 18), kind: 'plan', summary: 'Plan accepted with six steps and a thirteen-week horizon.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, 3 * HOUR), kind: 'action', summary: 'Demand history retrieved from four shipment exports.', actorId: 'agent-vector' },
      { id: 'ev-3', at: minutesAgo(DEMO_REFERENCE, 2 * HOUR + 12), kind: 'warning', summary: 'Three weeks of shipment data were missing and were reconciled against the warehouse ledger.', actorId: 'agent-vector' },
      { id: 'ev-4', at: minutesAgo(DEMO_REFERENCE, 95), kind: 'approval', summary: 'Operator approved the scenario drivers proposed by Ledger.', actorId: null },
      { id: 'ev-5', at: minutesAgo(DEMO_REFERENCE, 42), kind: 'artifact', summary: 'Scenario workbook v2 produced with three cases and four supplier sheets.', actorId: 'agent-ledger' },
      { id: 'ev-6', at: minutesAgo(DEMO_REFERENCE, 2), kind: 'action', summary: 'Capacity cross-check queued behind the scenario run.', actorId: 'agent-atlas' },
    ],
    artifacts: [
      { id: 'ar-1', name: 'Scenario workbook v2', kind: 'dataset', meta: '3 cases · 4 suppliers' },
      { id: 'ar-2', name: 'Demand reconciliation note', kind: 'memo', meta: '2 pages · reconciled' },
      { id: 'ar-3', name: 'Supplier lead-time extract', kind: 'dataset', meta: '18 rows · 42 KB' },
    ],
  },
  {
    id: 'mis-vendor-diligence',
    title: 'Vendor diligence — Halden Systems',
    objective: 'Assess whether Halden Systems meets the standard for a tier-two infrastructure vendor.',
    brief: 'Procurement asked for an independent read on Halden Systems before the renewal. The desk needs the contractual exposure, the operational record, and a recommendation with the questions that remain open.',
    status: 'awaiting',
    progress: 38,
    createdAt: minutesAgo(DEMO_REFERENCE, DAY + 5 * HOUR),
    updatedAt: minutesAgo(DEMO_REFERENCE, 24),
    agentIds: ['agent-atlas', 'agent-quill'],
    desk: 'Procurement desk',
    steps: [
      { id: 'st-1', title: 'Assemble the evidence pack', detail: 'Collected the master agreement, the two amendments, and the last four service reviews.', status: 'complete', agentId: 'agent-atlas', timing: '5m 30s' },
      { id: 'st-2', title: 'Extract contractual exposure', detail: 'The renewal’s liability cap is below the desk’s threshold and needs an operator decision.', status: 'failed', agentId: 'agent-quill', timing: '1m 08s' },
      { id: 'st-3', title: 'Operator decision on exposure', detail: 'Confirm whether the liability cap is acceptable or the renewal needs renegotiation.', status: 'pending', agentId: null, timing: '—' },
      { id: 'st-4', title: 'Draft the recommendation', detail: 'Write the assessment against the tier-two standard.', status: 'pending', agentId: 'agent-quill', timing: '—' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, DAY + 4), kind: 'plan', summary: 'Plan accepted with four steps.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, DAY + 1), kind: 'action', summary: 'Sixteen documents indexed into the evidence pack.', actorId: 'agent-vector' },
      { id: 'ev-3', at: minutesAgo(DEMO_REFERENCE, 40), kind: 'failure', summary: 'Contract extraction stopped: the liability cap is below the desk threshold.', actorId: 'agent-quill' },
      { id: 'ev-4', at: minutesAgo(DEMO_REFERENCE, 24), kind: 'approval', summary: 'Mission paused and routed to the operator for a decision.', actorId: 'agent-sentry' },
    ],
    artifacts: [
      { id: 'ar-1', name: 'Evidence pack index', kind: 'brief', meta: '16 documents' },
      { id: 'ar-2', name: 'Contract exposure extract', kind: 'memo', meta: 'Draft · blocked' },
    ],
  },
  {
    id: 'mis-margin-audit',
    title: 'Margin audit — hardware line',
    objective: 'Explain the 2.4 point gross-margin decline on the hardware line.',
    brief: 'The line lost margin in two consecutive quarters. The desk needs the decline attributed to price, mix, and cost with a defensible split, plus a short list of where the next quarter can recover it.',
    status: 'review',
    progress: 92,
    createdAt: minutesAgo(DEMO_REFERENCE, 2 * DAY + 3 * HOUR),
    updatedAt: minutesAgo(DEMO_REFERENCE, 12),
    agentIds: ['agent-ledger', 'agent-sentry'],
    desk: 'Finance desk',
    steps: [
      { id: 'st-1', title: 'Rebuild the margin bridge', detail: 'Reconstructed the price, mix, and cost split from the ledger export.', status: 'complete', agentId: 'agent-ledger', timing: '12m 40s' },
      { id: 'st-2', title: 'Validate the attribution', detail: 'Recomputed the bridge independently and matched the totals to the ledger.', status: 'complete', agentId: 'agent-ledger', timing: '6m 15s' },
      { id: 'st-3', title: 'Verify acceptance criteria', detail: 'All four criteria met: totals agree, drivers are attributed, the recovery list is sourced, and the memo names its assumptions.', status: 'complete', agentId: 'agent-sentry', timing: '38s' },
      { id: 'st-4', title: 'Operator review', detail: 'The memo is waiting for the finance desk to accept it.', status: 'running', agentId: null, timing: '—' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, 2 * DAY + 2), kind: 'plan', summary: 'Plan accepted with four steps.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, 30 * HOUR), kind: 'action', summary: 'Margin bridge computed from the ledger export.', actorId: 'agent-ledger' },
      { id: 'ev-3', at: minutesAgo(DEMO_REFERENCE, 20 * HOUR), kind: 'artifact', summary: 'Bridge workbook and attribution memo produced.', actorId: 'agent-ledger' },
      { id: 'ev-4', at: minutesAgo(DEMO_REFERENCE, 12), kind: 'approval', summary: 'Verification passed; the memo is waiting on the finance desk.', actorId: 'agent-sentry' },
    ],
    artifacts: [
      { id: 'ar-1', name: 'Margin bridge', kind: 'dataset', meta: '92 rows · 1.8 MB' },
      { id: 'ar-2', name: 'Attribution memo', kind: 'memo', meta: '4 pages · verified' },
    ],
  },
  {
    id: 'mis-onboarding',
    title: 'Supplier onboarding — Kestrel Metals',
    objective: 'Onboard Kestrel Metals as an approved supplier for the eastern region.',
    brief: 'Complete the standard onboarding record and confirm each control before the supplier can take purchase orders.',
    status: 'complete',
    progress: 100,
    createdAt: minutesAgo(DEMO_REFERENCE, 4 * DAY),
    updatedAt: minutesAgo(DEMO_REFERENCE, 2 * DAY + 6 * HOUR),
    agentIds: ['agent-sentry', 'agent-quill'],
    desk: 'Procurement desk',
    steps: [
      { id: 'st-1', title: 'Collect the onboarding record', detail: 'Registration, insurance, and the two reference checks collected.', status: 'complete', agentId: 'agent-vector', timing: '8m 04s' },
      { id: 'st-2', title: 'Run the control review', detail: 'All eleven controls met with evidence attached.', status: 'complete', agentId: 'agent-sentry', timing: '52s' },
      { id: 'st-3', title: 'Publish the approval', detail: 'Published to the supplier register for the eastern region.', status: 'complete', agentId: 'agent-quill', timing: '1m 20s' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, 4 * DAY - 10), kind: 'plan', summary: 'Plan accepted with three steps.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, 2 * DAY - 11), kind: 'approval', summary: 'Control review passed on the first attempt.', actorId: 'agent-sentry' },
      { id: 'ev-3', at: minutesAgo(DEMO_REFERENCE, 2 * DAY + 6), kind: 'artifact', summary: 'Approval published to the supplier register.', actorId: 'agent-quill' },
    ],
    artifacts: [
      { id: 'ar-1', name: 'Onboarding record', kind: 'report', meta: '11 controls · verified' },
      { id: 'ar-2', name: 'Reference summary', kind: 'brief', meta: '2 pages' },
    ],
  },
  {
    id: 'mis-freight',
    title: 'Freight exception triage',
    objective: 'Clear the backlog of freight exceptions older than five days.',
    brief: 'Forty-one exceptions accumulated during the port closure. Each needs a disposition: release, dispute, or write-off.',
    status: 'paused',
    progress: 17,
    createdAt: minutesAgo(DEMO_REFERENCE, 6 * HOUR),
    updatedAt: minutesAgo(DEMO_REFERENCE, 4 * HOUR),
    agentIds: ['agent-atlas'],
    desk: 'Operations desk',
    steps: [
      { id: 'st-1', title: 'Classify the exception backlog', detail: 'Grouped forty-one exceptions by cause and carrier.', status: 'complete', agentId: 'agent-atlas', timing: '2m 51s' },
      { id: 'st-2', title: 'Disposition each exception', detail: 'Waiting on the carrier rate card, which the operations desk has not shared yet.', status: 'pending', agentId: null, timing: '—' },
      { id: 'st-3', title: 'Write the write-off list', detail: 'Summarise the exceptions that cannot be recovered.', status: 'pending', agentId: null, timing: '—' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, 5 * HOUR), kind: 'plan', summary: 'Plan accepted with three steps.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, 4 * HOUR), kind: 'warning', summary: 'Paused: the carrier rate card is missing from the knowledge collections.', actorId: 'agent-atlas' },
    ],
    artifacts: [
      { id: 'ar-1', name: 'Exception classification', kind: 'dataset', meta: '41 rows' },
    ],
  },
  {
    id: 'mis-pricing',
    title: 'Renewal pricing test',
    objective: 'Test whether a three-tier renewal ladder lifts retention without eroding margin.',
    brief: 'Price sensitivity is unknown for the mid-market segment. The desk wants a design that can answer the question with the traffic the segment already has.',
    status: 'failed',
    progress: 24,
    createdAt: minutesAgo(DEMO_REFERENCE, 9 * HOUR),
    updatedAt: minutesAgo(DEMO_REFERENCE, 7 * HOUR),
    agentIds: ['agent-ledger'],
    desk: 'Finance desk',
    steps: [
      { id: 'st-1', title: 'Frame the test', detail: 'Defined the three tiers and the retention measure.', status: 'complete', agentId: 'agent-atlas', timing: '3m 12s' },
      { id: 'st-2', title: 'Check the sample size', detail: 'The segment does not carry enough traffic for the effect size the desk expects.', status: 'failed', agentId: 'agent-ledger', timing: '1m 44s' },
      { id: 'st-3', title: 'Propose an alternative design', detail: 'Consider a holdout on the whole renewal cohort instead of the segment.', status: 'skipped', agentId: null, timing: '—' },
    ],
    events: [
      { id: 'ev-1', at: minutesAgo(DEMO_REFERENCE, 8 * HOUR), kind: 'plan', summary: 'Plan accepted with three steps.', actorId: 'agent-atlas' },
      { id: 'ev-2', at: minutesAgo(DEMO_REFERENCE, 7 * HOUR), kind: 'failure', summary: 'Stopped: the segment sample supports only a 6 point effect at 80% power.', actorId: 'agent-ledger' },
    ],
    artifacts: [],
  },
]

const COLLECTIONS: readonly KnowledgeCollection[] = [
  {
    id: 'col-contracts',
    name: 'Supplier agreements',
    summary: 'Executed contracts, amendments, and the clause register for every approved supplier.',
    count: 4,
    indexed: true,
    clearance: 'Internal',
    updatedAt: minutesAgo(DEMO_REFERENCE, 46),
  },
  {
    id: 'col-finance',
    name: 'Finance archive',
    summary: 'Monthly ledger exports, margin bridges, and the audit trail behind each closed period.',
    count: 3,
    indexed: true,
    clearance: 'Confidential',
    updatedAt: minutesAgo(DEMO_REFERENCE, 3 * HOUR),
  },
  {
    id: 'col-ops',
    name: 'Operations playbooks',
    summary: 'Standard procedures for the desks, including escalation routes and approval thresholds.',
    count: 3,
    indexed: true,
    clearance: 'Internal',
    updatedAt: minutesAgo(DEMO_REFERENCE, DAY),
  },
  {
    id: 'col-policy',
    name: 'Policy and standards',
    summary: 'The desk standards a mission is verified against, versioned by effective date.',
    count: 3,
    indexed: true,
    clearance: 'Internal',
    updatedAt: minutesAgo(DEMO_REFERENCE, 2 * DAY),
  },
  {
    id: 'col-market',
    name: 'Market intelligence',
    summary: 'External research and trade press, refreshed weekly from the subscribed feeds.',
    count: 2,
    indexed: false,
    clearance: 'Public',
    updatedAt: minutesAgo(DEMO_REFERENCE, 4 * HOUR),
  },
]

const RESOURCES: readonly KnowledgeResource[] = [
  { id: 'res-1', collectionId: 'col-contracts', title: 'Halden Systems — master services agreement', source: 'Legal vault', format: 'pdf', updatedAt: minutesAgo(DEMO_REFERENCE, DAY), size: '1.2 MB', citations: 4, tags: ['vendor', 'liability'] },
  { id: 'res-2', collectionId: 'col-contracts', title: 'Halden Systems — amendment 2 (renewal terms)', source: 'Legal vault', format: 'pdf', updatedAt: minutesAgo(DEMO_REFERENCE, 3 * DAY), size: '640 KB', citations: 2, tags: ['vendor', 'renewal'] },
  { id: 'res-3', collectionId: 'col-contracts', title: 'Kestrel Metals — onboarding record', source: 'Supplier register', format: 'doc', updatedAt: minutesAgo(DEMO_REFERENCE, 2 * DAY), size: '310 KB', citations: 1, tags: ['vendor', 'onboarding'] },
  { id: 'res-4', collectionId: 'col-finance', title: 'Hardware line — Q3 ledger export', source: 'Finance archive', format: 'sheet', updatedAt: minutesAgo(DEMO_REFERENCE, 3 * HOUR), size: '4.8 MB', citations: 7, tags: ['margin', 'ledger'] },
  { id: 'res-5', collectionId: 'col-finance', title: 'Gross margin bridge — method note', source: 'Finance archive', format: 'doc', updatedAt: minutesAgo(DEMO_REFERENCE, 5 * DAY), size: '180 KB', citations: 12, tags: ['margin', 'method'] },
  { id: 'res-6', collectionId: 'col-ops', title: 'Replenishment planning playbook', source: 'Operations desk', format: 'note', updatedAt: minutesAgo(DEMO_REFERENCE, 2 * DAY), size: '24 KB', citations: 9, tags: ['supply', 'playbook'] },
  { id: 'res-7', collectionId: 'col-ops', title: 'Freight exception handling procedure', source: 'Operations desk', format: 'note', updatedAt: minutesAgo(DEMO_REFERENCE, 4 * DAY), size: '18 KB', citations: 3, tags: ['freight', 'exception'] },
  { id: 'res-8', collectionId: 'col-ops', title: 'Northern network capacity map', source: 'Operations desk', format: 'pdf', updatedAt: minutesAgo(DEMO_REFERENCE, 6 * DAY), size: '7.1 MB', citations: 5, tags: ['supply', 'capacity'] },
  { id: 'res-9', collectionId: 'col-policy', title: 'Tier-two vendor standard v4', source: 'Policy library', format: 'pdf', updatedAt: minutesAgo(DEMO_REFERENCE, 8 * DAY), size: '420 KB', citations: 18, tags: ['vendor', 'standard'] },
  { id: 'res-10', collectionId: 'col-policy', title: 'Approval thresholds by desk', source: 'Policy library', format: 'doc', updatedAt: minutesAgo(DEMO_REFERENCE, 12 * DAY), size: '96 KB', citations: 26, tags: ['approval', 'threshold'] },
  { id: 'res-11', collectionId: 'col-policy', title: 'Write-off policy — freight', source: 'Policy library', format: 'doc', updatedAt: minutesAgo(DEMO_REFERENCE, 20 * DAY), size: '72 KB', citations: 2, tags: ['freight', 'policy'] },
  { id: 'res-12', collectionId: 'col-market', title: 'Container rates — weekly index', source: 'Trade feed', format: 'web', updatedAt: minutesAgo(DEMO_REFERENCE, 4 * HOUR), size: '—', citations: 0, tags: ['freight', 'rates'] },
  { id: 'res-13', collectionId: 'col-market', title: 'Northern region demand outlook', source: 'Research subscription', format: 'pdf', updatedAt: minutesAgo(DEMO_REFERENCE, 2 * DAY), size: '2.6 MB', citations: 6, tags: ['demand', 'outlook'] },
  { id: 'res-14', collectionId: 'col-finance', title: 'Renewal cohort — retention by tier', source: 'Finance archive', format: 'dataset', updatedAt: minutesAgo(DEMO_REFERENCE, 7 * HOUR), size: '12 MB', citations: 1, tags: ['retention', 'pricing'] },
  { id: 'res-15', collectionId: 'col-contracts', title: 'Supplier lead-time register', source: 'Supplier register', format: 'sheet', updatedAt: minutesAgo(DEMO_REFERENCE, 6 * HOUR), size: '88 KB', citations: 11, tags: ['supply', 'lead-time'] },
]

const ACTIVITY: readonly ActivityEntry[] = [
  { id: 'act-1', at: minutesAgo(DEMO_REFERENCE, 2), scope: 'mission', outcome: 'info', title: 'Scenario run started', detail: 'Ledger began the replenishment scenarios for Q4 supply review.', missionId: 'mis-q4-supply', agentId: 'agent-ledger' },
  { id: 'act-2', at: minutesAgo(DEMO_REFERENCE, 12), scope: 'mission', outcome: 'attention', title: 'Verification passed, review requested', detail: 'Margin audit is waiting on the finance desk to accept the memo.', missionId: 'mis-margin-audit', agentId: 'agent-sentry' },
  { id: 'act-3', at: minutesAgo(DEMO_REFERENCE, 24), scope: 'mission', outcome: 'attention', title: 'Mission paused for a decision', detail: 'Vendor diligence stopped at the liability cap and routed the decision to the operator.', missionId: 'mis-vendor-diligence', agentId: 'agent-quill' },
  { id: 'act-4', at: minutesAgo(DEMO_REFERENCE, 42), scope: 'mission', outcome: 'success', title: 'Artifact produced', detail: 'Scenario workbook v2 written with three cases across four suppliers.', missionId: 'mis-q4-supply', agentId: 'agent-ledger' },
  { id: 'act-5', at: minutesAgo(DEMO_REFERENCE, 46), scope: 'system', outcome: 'info', title: 'Collection reindexed', detail: 'Supplier agreements reindexed after the amendment was filed.', missionId: null, agentId: null },
  { id: 'act-6', at: minutesAgo(DEMO_REFERENCE, 95), scope: 'mission', outcome: 'success', title: 'Operator approval recorded', detail: 'The scenario drivers proposed by Ledger were approved.', missionId: 'mis-q4-supply', agentId: null },
  { id: 'act-7', at: minutesAgo(DEMO_REFERENCE, 2 * HOUR + 12), scope: 'mission', outcome: 'attention', title: 'Data gap reconciled', detail: 'Three missing shipment weeks were reconciled against the warehouse ledger.', missionId: 'mis-q4-supply', agentId: 'agent-vector' },
  { id: 'act-8', at: minutesAgo(DEMO_REFERENCE, 4 * HOUR), scope: 'mission', outcome: 'attention', title: 'Mission paused', detail: 'Freight exception triage is waiting on the carrier rate card.', missionId: 'mis-freight', agentId: 'agent-atlas' },
  { id: 'act-9', at: minutesAgo(DEMO_REFERENCE, 7 * HOUR), scope: 'mission', outcome: 'failure', title: 'Mission stopped', detail: 'Renewal pricing test stopped: the segment cannot support the expected effect size.', missionId: 'mis-pricing', agentId: 'agent-ledger' },
  { id: 'act-10', at: minutesAgo(DEMO_REFERENCE, 9 * HOUR), scope: 'agent', outcome: 'info', title: 'Agent registered', detail: 'Quill was added to the procurement desk roster.', missionId: null, agentId: 'agent-quill' },
  { id: 'act-11', at: minutesAgo(DEMO_REFERENCE, 30 * HOUR), scope: 'mission', outcome: 'success', title: 'Margin bridge computed', detail: 'The bridge reconciled to the ledger export on the first pass.', missionId: 'mis-margin-audit', agentId: 'agent-ledger' },
  { id: 'act-12', at: minutesAgo(DEMO_REFERENCE, 2 * DAY + 6), scope: 'mission', outcome: 'success', title: 'Mission completed', detail: 'Kestrel Metals was onboarded and published to the supplier register.', missionId: 'mis-onboarding', agentId: 'agent-quill' },
  { id: 'act-13', at: minutesAgo(DEMO_REFERENCE, 3 * DAY), scope: 'agent', outcome: 'info', title: 'Agent went offline', detail: 'Hermes is offline until the desk re-enables the ledger connection.', missionId: null, agentId: 'agent-hermes' },
  { id: 'act-14', at: minutesAgo(DEMO_REFERENCE, 3 * DAY), scope: 'system', outcome: 'info', title: 'Retention window applied', detail: 'Market intelligence refreshed; 112 stale documents dropped from the index.', missionId: null, agentId: null },
]

/** The demonstration workspace the prototype boots with. */
export const DEMO_WORKSPACE: Workspace = {
  name: 'Northern operations',
  operator: 'M. Okonkwo',
  operatorInitials: 'MO',
  status: {
    state: 'nominal',
    label: 'operational',
    detail: 'All services responding · last check 40s ago',
    load: '38%',
    queue: 3,
  },
  indicators: [
    { id: 'ind-missions', label: 'Active missions', value: '6', detail: '2 running · 1 awaiting you', delta: '+2 today', tone: 'accent' },
    { id: 'ind-decisions', label: 'Awaiting decision', value: '2', detail: 'Oldest waiting 24 minutes', delta: null, tone: 'warn' },
    { id: 'ind-agents', label: 'Agents engaged', value: '4 / 6', detail: '2 available for new work', delta: null, tone: 'neutral' },
    { id: 'ind-runs', label: 'Runs today', value: '27', detail: 'Mean 2m 04s · 96% succeeded', delta: '+8 vs. yesterday', tone: 'neutral' },
  ],
  missions: MISSIONS,
  agents: AGENTS,
  collections: COLLECTIONS,
  resources: RESOURCES,
  activity: ACTIVITY,
}

/** Mission statuses offered as list filters, in lifecycle order. */
export const MISSION_FILTERS = ['all', 'running', 'awaiting', 'review', 'complete', 'failed'] as const

/** Activity scopes offered as timeline filters. */
export const ACTIVITY_SCOPES = ['all', 'mission', 'agent', 'system'] as const

/** Activity outcomes offered as timeline filters. */
export const ACTIVITY_OUTCOMES = ['all', 'success', 'failure', 'attention'] as const

/** Settings sections, in the order the settings screen shows them. */
export const SETTINGS_SECTIONS = ['general', 'appearance', 'models', 'memory', 'integrations', 'security'] as const

/** A settings section identifier. */
export type SettingsSection = typeof SETTINGS_SECTIONS[number]

/** A mission list filter identifier. */
export type MissionFilter = typeof MISSION_FILTERS[number]

/** An activity scope filter identifier. */
export type ActivityScope = typeof ACTIVITY_SCOPES[number]

/** An activity outcome filter identifier. */
export type ActivityOutcome = typeof ACTIVITY_OUTCOMES[number]
