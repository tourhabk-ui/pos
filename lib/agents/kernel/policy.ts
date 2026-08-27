/**
 * Agent Kernel v1 — policy decision point.
 *
 * Решение allow / ask / deny принадлежит ЯДРУ (решение владельца 27.08):
 * ApprovalRequired — адаптер ХРАНЕНИЯ человеческого одобрения, а не скрытое
 * ядро новой ОС. Реестр capabilities — единственный источник риска; вход не
 * из реестра — ask, fail-closed (тот же принцип, что дефолт 'review' в
 * ApprovalRequired после PR #1399).
 *
 * Решение вычисляется из КОДА и текущего состояния, поэтому перед commit
 * его можно и нужно спросить повторно (executeGovernedAction так и делает):
 * между policy check и эффектом состояние могло устареть.
 */

import type { PolicyDecision, TaskRisk } from './types';

export interface CapabilityEntry {
  risk: TaskRisk;
  /** Почему такая категория — читает человек при ревью реестра. */
  reason: string;
}

/**
 * Реестр capabilities v1 — только то, что реально подключено к ядру.
 * Расширять вместе с настоящим вызывающим кодом, не «на будущее»
 * (урок ACTION_CATEGORIES до PR #1399: мёртвый реестр из 20 типов,
 * половина — 'safe' с несуществующими исполнителями).
 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityEntry>> = {
  'tour.set_published': {
    risk: 'safe',
    reason: 'оператор меняет публикацию СВОЕГО тура; принадлежность держит SQL (WHERE operator_id), действие обратимо',
  },
  'tour.update_price': {
    risk: 'safe',
    reason: 'оператор меняет цену СВОЕГО тура; принадлежность держит SQL, действие обратимо',
  },
  'initiative.execute': {
    risk: 'safe',
    reason: 'human gate уже пройден ВЫШЕ: execute-all берёт только status=approved из agent_approvals (одобрено поштучно человеком)',
  },
  'evo.run': {
    risk: 'safe',
    reason: 'оркестратор читает и предлагает; мутации кода идут через draft PR + merge человека, у детерминированных правок свои сторожа',
  },
};

/** Явно запрещённое — то же множество, что forbidden в ApprovalRequired. */
export const FORBIDDEN_CAPABILITIES: ReadonlySet<string> = new Set([
  'data.delete', 'auth.bypass', 'schema.change', 'payment.execute', 'safeguard.modify',
]);

export function decideCapability(capability: string): { decision: PolicyDecision; risk: TaskRisk; reason: string } {
  if (FORBIDDEN_CAPABILITIES.has(capability)) {
    return { decision: 'deny', risk: 'forbidden', reason: `capability '${capability}' запрещена системой` };
  }
  const entry = CAPABILITY_REGISTRY[capability];
  if (!entry) {
    // Fail-closed: незнакомое — к человеку, не в исполнение.
    return { decision: 'ask', risk: 'review', reason: `capability '${capability}' не в реестре — требуется одобрение человека` };
  }
  if (entry.risk === 'forbidden') {
    return { decision: 'deny', risk: 'forbidden', reason: entry.reason };
  }
  return { decision: entry.risk === 'safe' ? 'allow' : 'ask', risk: entry.risk, reason: entry.reason };
}
