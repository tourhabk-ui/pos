/**
 * GET /api/cron/agents-value-census?days=30 — перепись пользы агентов (05.11).
 *
 * Владелец: «проведи аудит всех наших агентов — нужно ли такое количество?».
 * Каждая запись реестра кронов и её журнал прогонов за окно: сколько раз шла,
 * чем кончилась, сколько обработала и создала, сколько вызовов модели и
 * денег, когда в последний раз что-то сделала. Род — productive / idle /
 * unmeasured / silent / no_telemetry (lib/agents/agents-value-census).
 *
 * Деньги — из книг llm_usage_log, не из журнала (v2, 05.11): у каждой записи
 * поле `llm`, рядом `llm_unattributed` (вызов без агента) и
 * `llm_outside_registry` (агенты вне реестра — Кузьмич, оценщики, «руки»).
 * v3 (06.11): `llm_by_agent_model` — пары «агент × модель», самые частые
 * первыми, не больше LLM_BY_MODEL_LIMIT: какая модель осталась без цены и чем
 * тратит дорогой агент.
 *
 * Только чтение, только числа — ПД нет. Ручной: зовёт проба (prod-check),
 * объявлен в lib/agents/cron-schedulers.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { DEFAULT_DAYS, MAX_DAYS, readAgentsValueCensus, type AgentValueKind } from '@/lib/agents/agents-value-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!process.env.CRON_SECRET || !timingSafeCompare(secret, process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: 'Доступ запрещён' }, { status: 401 });
  }
  const raw = Number(new URL(request.url).searchParams.get('days'));
  const days = Number.isInteger(raw) && raw >= 1 ? Math.min(MAX_DAYS, raw) : DEFAULT_DAYS;
  try {
    const census = await readAgentsValueCensus(days);
    const rows = census.items;
    const byKind: Record<AgentValueKind, number> = { productive: 0, idle: 0, unmeasured: 0, silent: 0, no_telemetry: 0 };
    for (const r of rows) byKind[r.kind]++;
    const cost = rows.reduce((s, r) => s + (r.stats?.cost_usd ?? 0), 0);
    const booksCost = rows.reduce((s, r) => s + (r.llm?.cost_usd ?? 0), 0);
    return NextResponse.json({
      ok: true,
      probe: 'agents_value_census_v3',
      days,
      agents: rows.length,
      by_kind: byKind,
      // Деньги по журналу прогонов (как в v1) и по книгам расхода — разные
      // источники, и расходятся они намеренно видимо: журнал знает только
      // тех, кто сам называет свой расход.
      llm_cost_usd: Number(cost.toFixed(4)),
      llm_books_registry_usd: Number(booksCost.toFixed(4)),
      llm_unattributed: census.llm_unattributed,
      llm_outside_registry: census.llm_outside_registry,
      llm_by_agent_model: census.llm_by_agent_model,
      // Сначала те, о ком решать: холостые, молчащие и без меры, потом польза.
      items: [...rows].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key)),
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[agents-value-census] журнал прогонов не прочитан, SQLSTATE', code);
    return NextResponse.json({ ok: false, error: 'Журнал прогонов не прочитан' }, { status: 503 });
  }
}

const ORDER: Record<AgentValueKind, number> = { idle: 0, silent: 1, unmeasured: 2, no_telemetry: 3, productive: 4 };
