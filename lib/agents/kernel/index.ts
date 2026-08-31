/**
 * Volcano OS — Agent Kernel, точка входа (barrel).
 *
 * Снаружи используется ровно это: executeGovernedAction — единственный
 * управляемый путь операционной мутации; kernel-примитивы — для адаптеров,
 * worker'а и кокпита.
 */
export { executeGovernedAction, hashInput } from './governed-action';
export { beginEffect, commitEffect, failEffect, findStuckEffects } from './effects';
export type { AgentEffect, EffectStatus, BeginEffectResult } from './effects';
export { decidePolicy, CAPABILITY_REGISTRY, FORBIDDEN_CAPABILITIES } from './policy';
export {
  createTask,
  transition,
  claimTaskById,
  claimNextTask,
  appendEvent,
  findByIdempotencyKey,
  findActiveByIdempotencyKey,
  findActiveByResource,
  reapExpiredLeases,
  POLICY_VERSION,
  DEFAULT_LEASE_SECONDS,
  LEASE_REAP_GRACE_SECONDS,
} from './kernel';
export type { CreateConflict, CreateTaskOutcome, ReapedTask } from './kernel';
export {
  TASK_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  IDEMPOTENCY_ACTIVE_STATES,
  isTransitionAllowed,
  principalToString,
} from './types';
export type {
  AgentTask,
  TaskState,
  TaskRisk,
  PolicyDecision,
  PolicyContext,
  PolicyVerdict,
  TrustedPrincipal,
  GovernedActionInput,
  GovernedActionResult,
} from './types';
