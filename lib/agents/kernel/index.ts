/**
 * Agent Kernel v1 — точка входа (barrel).
 *
 * Снаружи используется ровно это: executeGovernedAction — единственный
 * управляемый путь мутации; kernel-примитивы — для адаптеров и кокпита.
 */
export { executeGovernedAction, hashInput } from './governed-action';
export { decideCapability, CAPABILITY_REGISTRY, FORBIDDEN_CAPABILITIES } from './policy';
export {
  createTask,
  transition,
  claimTask,
  appendEvent,
  findByIdempotencyKey,
  POLICY_VERSION,
  DEFAULT_LEASE_SECONDS,
} from './kernel';
export {
  TASK_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
} from './types';
export type {
  AgentTask,
  TaskState,
  TaskRisk,
  PolicyDecision,
  GovernedActionInput,
  GovernedActionResult,
} from './types';
