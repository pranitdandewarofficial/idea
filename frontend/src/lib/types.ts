/**
 * Types mirroring the FastAPI responses. Every field here is produced by a real
 * endpoint - there is no client-only state pretending to be backend data.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; context: Record<string, unknown>; request_id: string };
}

export interface Health {
  ok: boolean;
  version: string;
  zero_spend: boolean;
  auth_enabled: boolean;
  sandbox_tier: number;
  docker_available: boolean;
  decisions_enabled: boolean;
  decision_engine: string;
  counts: { providers: number; agents: number; projects: number; plans: number };
  runs: Record<string, unknown>;
  python: string;
  platform: string;
}

export interface SetupStatus {
  complete: boolean;
  has_provider: boolean;
  has_free_provider: boolean;
  providers: ProviderSummary[];
  zero_spend: boolean;
  api_token: string | null;
  api_base: string;
  workspaces_dir: string;
  decision_layer: {
    enabled: boolean;
    engine: string;
    laya_available: boolean;
    laya_reason: string;
    threshold: number;
  };
  sandbox: { tier: number; docker_available: boolean };
}

export interface ProviderSummary {
  id: string;
  label: string;
  kind: string;
  is_paid: boolean;
  is_enabled: boolean;
  default_model: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  department: string;
  personality: string;
  responsibilities: string[];
  prohibited: string[];
  skills: string[];
  tools: string[];
  model_role: string;
  provider_id: string | null;
  model: string | null;
  memory_namespace: string;
  max_parallel_tasks: number;
  temperature: number;
  max_tokens: number;
  is_enabled: boolean;
  status: AgentStatus;
  current_task_id: string | null;
  avatar_seed: string;
  city_x: number;
  city_y: number;
  home_x: number;
  home_y: number;
  is_decision_agent: boolean;
  output_contract: { type?: string; required?: string[]; must_contain?: string[] };
  load?: number;
  current_task?: { id: string; title: string; status: string } | null;
}

export type AgentStatus = "idle" | "working" | "collaborating" | "blocked" | "waiting" | "offline";

export interface Task {
  id: string;
  external_id: string;
  plan_id: string;
  project_id: string;
  title: string;
  description: string;
  agent_id: string | null;
  status: TaskStatus;
  depends_on: string[];
  outputs: string[];
  done_criteria: string[];
  verify_commands: string[];
  priority: number;
  effort: number;
  order_index: number;
  retries: number;
  summary: string | null;
  error: string | null;
  files_changed: string[];
  verification: Verification;
  tokens_used: number;
  created_at: string | null;
  updated_at: string | null;
}

export type TaskStatus =
  | "pending" | "ready" | "running" | "failed" | "repairing"
  | "blocked" | "timeout" | "completed" | "cancelled";

export interface VerificationCheck {
  command: string;
  code: number | null;
  passed: boolean;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
  sandbox?: string;
  duration_ms?: number;
  policy_denied?: boolean;
}

export interface Verification {
  verified: boolean | null;
  checks: VerificationCheck[];
  reason?: string;
}

export type PlanState =
  | "draft" | "received" | "clarifying" | "planning" | "scheduled" | "scheduling" | "executing"
  | "verifying" | "repairing" | "integrating" | "reviewing" | "delivering"
  | "complete" | "failed" | "cancelled" | "paused" | "blocked";

export interface Plan {
  id: string;
  project_id: string;
  objective: string;
  state: PlanState;
  requirements: string[];
  acceptance_criteria: string[];
  assumptions: string[];
  clarifying_questions: string[];
  heuristic: boolean;
  validation: PlanValidation;
  progress: number;
  weight_done: number;
  weight_total: number;
  tokens_used: number;
  cost_estimate: number;
  spend_authorized: boolean;
  failure_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at?: string | null;
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  task_count: number;
  order: string[];
  actionable_ratio: number;
  coverage_ratio: number;
  estimated_tokens: number;
  token_budget: number;
  budget_ok: boolean;
}

export interface Project {
  id: string;
  name: string;
  objective: string;
  workspace_path: string;
  status: string;
  preview_url: string | null;
  preview_port: number | null;
  git_branch: string | null;
  created_at: string | null;
  report?: DeliveryReport;
  plans?: { id: string; state: string; progress: number; heuristic: boolean; objective: string;
            failure_reason: string | null; created_at: string | null }[];
  tasks?: Pick<Task, "id" | "external_id" | "title" | "status" | "agent_id" | "files_changed"
               | "verification" | "error">[];
  preview?: PreviewStatus;
}

/** GET /api/projects/{id}/preview - the real state of the dev-server subprocess. */
export interface PreviewStatus {
  running: boolean;
  port?: number | null;
  local_url?: string | null;
  public_url?: string | null;
  command?: string | null;
  exit_code?: number | null;
  log?: string;
  log_tail?: string[];
}

export interface DeliveryReport {
  project: { id: string; name: string; workspace: string };
  objective: string;
  state: string;
  delivered: boolean;
  summary: string;
  requirements: string[];
  acceptance_criteria: { criterion: string; status: string; evidence?: string }[];
  tasks: {
    id: string; title: string; agent_id: string | null; status: string; retries: number;
    files_changed: string[]; verified: boolean | null; summary: string;
  }[];
  verification: Record<string, unknown>;
  artifacts: { files: { path: string; size: number }[]; file_count: number; workspace_hash: string };
  metrics: {
    task_counts: Record<string, number>;
    tool_calls: number;
    tool_calls_denied: number;
    decisions: number;
    decision_engines: Record<string, number>;
    decisions_escalated_to_llm: number;
    tokens_in: number;
    tokens_out: number;
    cost_estimate: number;
    mocked_calls: number;
    tokens_used?: number;
    tokens_plan_budget?: number;
    tokens_global_budget?: number;
    calls?: number;
  };
  preview: Record<string, unknown>;
  limitations: string[];
  used_mock_provider: boolean;
}

export interface Provider {
  id: string;
  label: string;
  kind: string;
  base_url: string;
  organization_id: string | null;
  default_model: string | null;
  fallback_model: string | null;
  is_paid: boolean;
  is_enabled: boolean;
  requests_per_minute: number;
  max_concurrent: number;
  timeout_seconds: number;
  max_retries: number;
  extra_headers: Record<string, string>;
  role_models: Record<string, string>;
  models_discovered: string[];
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_test_latency_ms: number | null;
  has_key: boolean;
  key_fingerprint: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latency_ms: number;
  kind: string;
  is_paid: boolean;
  mocked: boolean;
  model: string | null;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  kind: string;
  size_bytes: number;
  checksum: string;
  tags: string[];
  index_status: string;
  chunk_count: number;
  error: string | null;
  created_at: string | null;
}

/** GET /api/knowledge/search - BM25 over the stored chunks. */
export interface KnowledgeHit {
  score: number;
  text: string;
  source_id: string;
  source_name: string;
  position: number;
  tags: string[];
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeHit[];
  engine: string;
  indexed_chunks?: number;
  note?: string;
}

export interface KnowledgeStats {
  sources: number;
  chunks: number;
  bytes: number;
  engine: string;
  embedding_model: string | null;
}

export interface Approval {
  id: string;
  action: string;
  requested_by: string;
  risk: "low" | "medium" | "high" | "critical";
  risk_score: number;
  status: "pending" | "approved" | "denied" | "expired";
  detail: Record<string, unknown>;
  plan_id: string | null;
  task_id: string | null;
  created_at: string | null;
  decision_note: string | null;
}

export interface DecisionRecord {
  id: string;
  decision_type: string;
  engine: string;
  confidence: number;
  action: "auto" | "escalate";
  fallback_used: boolean;
  latency_ms: number;
  state_hash: string;
  answers: Record<string, { value: unknown; probability?: number; confidence?: number }>;
  plan_id: string | null;
  task_id: string | null;
  created_at: string | null;
}

export interface DecisionStatus {
  stats: Record<string, unknown>;
  laya: { available: boolean; mode: string; reason: string; latency_ms?: number; version?: string };
  threshold: number;
  thresholds_by_type: Record<string, number>;
  type_strictness: Record<string, number>;
  enabled: boolean;
}

export interface AppEvent {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  priority: "low" | "normal" | "high" | "critical";
  notify: boolean;
  ts: string | null;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  result: string;
  context: Record<string, unknown>;
  created_at: string | null;
}

export interface Building {
  id: string;
  name: string;
  department: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  accent: string;
  icon: string;
  detail: string;
  seats: [number, number][];
}

export interface CityAgent {
  id: string;
  name: string;
  role: string;
  department: string;
  status: AgentStatus;
  building_id: string;
  home_x: number;
  home_y: number;
  city_x: number;
  city_y: number;
  seat: number;
  load: number;
  is_decision_agent: boolean;
  current_task: { id: string; title: string; status: string } | null;
  avatar_seed?: string;
  model_role?: string;
  model?: string | null;
  tools?: string[];
  skills?: string[];
  is_enabled?: boolean;
}

export interface CityLayout {
  world: { width: number; height: number };
  buildings: Building[];
  roads: { from: [number, number]; to: [number, number] }[];
  agents: CityAgent[];
  order?: string[];
  buildings_state: Record<string, { active: number; blocked: number; agents: string[] }>;
  task_markers: {
    task_id: string; external_id: string; title: string; status: string; agent_id: string | null;
    building_id: string; x: number; y: number; retries: number; error: string;
  }[];
  active_plans: { id: string; project_id: string; state: string; progress: number; objective: string }[];
  pending_approvals: number;
  providers: ProviderSummary[];
  degraded_providers: string[];
  zero_spend: boolean;
  compact_mode: boolean;
}

export interface Settings {
  zero_spend: boolean;
  max_concurrency: number;
  max_tasks_per_agent: number;
  plan_token_budget: number;
  global_token_budget: number;
  sandbox_tier: number;
  decisions_enabled: boolean;
  decision_mode: string;
  decision_confidence_threshold: number;
  guardrail_sensitivity: string;
  auto_approve_low_risk: boolean;
  compact_mode: boolean;
  default_provider_id: string;
  fallback_provider_id: string;
  [key: string]: unknown;
}

/** GET /api/settings returns the values plus the metadata the Settings screen renders. */
export interface SettingsResponse {
  values: Settings;
  defaults: Record<string, unknown>;
  descriptions: Record<string, string>;
  api_token: string | null;
  auth_enabled: boolean;
  paths: { data_dir: string; workspaces_dir: string; database: string };
  sandbox: { tier: number; docker_image: string };
  usage: UsageSummary;
}

export interface UsageSummary {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  cost_estimate: number;
  mocked_calls: number;
  avg_latency_ms: number;
}

export interface MemoryItem {
  id: string;
  namespace: string;
  scope: string;
  key: string;
  content: string;
  kind: string;
  score: number;
}

export interface AgentTaskRow {
  id: string;
  external_id: string;
  title: string;
  status: string;
  plan_id: string;
  project_id: string;
  retries: number;
  error: string | null;
  files_changed: string[];
  created_at: string | null;
}

export interface ToolCallRow {
  id: string;
  tool: string;
  ok: boolean;
  denied: boolean;
  reason: string | null;
  task_id: string | null;
  exit_code: number | null;
  duration_ms: number;
  args: Record<string, unknown>;
  result_excerpt: string | null;
  created_at: string | null;
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  task_id: string | null;
  project_id: string | null;
  meta: Record<string, unknown>;
  created_at: string | null;
}

export interface Checkpoint {
  id: string;
  sequence: number;
  reason: string;
  created_at: string | null;
  task_count: number;
}

export interface BudgetState {
  tokens_used: number;
  tokens_plan_budget: number;
  tokens_global_budget: number;
  tokens_plan_remaining: number;
  cost_estimate: number;
  elapsed_seconds: number;
  calls: number;
  mocked_calls: number;
  ok: boolean;
  reason: string;
}
