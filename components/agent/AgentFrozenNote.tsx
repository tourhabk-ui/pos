/**
 * Строка сверху кабинета агента, пока роль заморожена (#3212): вознаграждение
 * не начисляется, пока Ведар не принимает оплату. Роль открыта — строки нет.
 * Правило одно — `agentRoleOpen()` (lib/auth/agent-role).
 */
import { Snowflake } from 'lucide-react';
import { agentRoleOpen, AGENT_ROLE_FROZEN_NOTE, AGENT_MONEY_CLOSED } from '@/lib/auth/agent-role';

export function AgentFrozenNote() {
  if (agentRoleOpen()) return null;
  return (
    <p
      role="status"
      data-testid="agent-frozen-note"
      className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-primary)]"
    >
      <Snowflake size={16} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden />
      <span>{AGENT_ROLE_FROZEN_NOTE}</span>
    </p>
  );
}

/** Раздел о деньгах агента по прямому адресу, пока роль заморожена. */
export function AgentMoneyClosed({ title }: { title: string }) {
  return (
    <section className="ds-card space-y-2" data-testid="agent-money-closed">
      <h1 className="ds-h2">{title}</h1>
      <p className="text-sm text-[var(--text-secondary)]">{AGENT_MONEY_CLOSED}</p>
    </section>
  );
}
