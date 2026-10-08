/**
 * lib/planner/plan-drafts.ts — черновики плана поездки (#2224, миграция 1182).
 *
 * make_trip_plan кладёт сюда собранный план и отдаёт его id; edit_trip_plan
 * читает план по id, правит (lib/planner/plan-edit) и пишет обратно новой
 * ревизией. Черновик без пользователя живёт 7 дней (решение владельца 08.10):
 * туристы в MCP и в Telegram анонимны. Доступ — знанием id.
 *
 * Текст пожеланий хранится только после redactPII (решение владельца 08.10:
 * «структуру и текст пожеланий»): телефоны и почта в черновик не попадают.
 *
 * Три исхода чтения, как требует §4.0: план есть; плана нет (не было,
 * истёк, id не UUID); прочитать не смогли. Третий не равен второму —
 * «план не найден» на отказ базы отправил бы человека собирать заново план,
 * который лежит на месте.
 */

import { pool } from '@/lib/db-pool';
import { redactPII } from '@/lib/security/pii-redact';
import type { DayPlan } from './engine';
import type { EditablePlan, PlanParams } from './plan-edit';

export type DraftSurface = 'chat' | 'mcp' | 'group';

export interface PlanDraft extends EditablePlan {
  id: string;
  revision: number;
  /**
   * До какого момента черновик читается (ISO). Страница плана (#2225) говорит
   * человеку, до какого числа живёт ссылка: без срока «откройте позже» было
   * бы обещанием, которое база через 7 дней нарушит молча.
   */
  expiresAt?: string;
}

export type DraftRead =
  | { kind: 'found'; draft: PlanDraft }
  | { kind: 'missing' }
  | { kind: 'failed' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDraftId(raw: string | undefined): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw.trim());
}

function logFail(what: string, err: unknown): void {
  const e = err as { code?: string; message?: string } | undefined;
  console.error(`[plan-drafts] ${what}`, { sqlstate: e?.code, message: e?.message });
}

/**
 * Сохранить новый черновик. null — записать не смогли (план всё равно
 * отдаётся человеку, только без id для правки). Истёкшие черновики удаляет
 * сам писатель: отдельного крона под 7-дневную уборку нет.
 */
export async function saveDraft(plan: EditablePlan, surface: DraftSurface, wishes: string | undefined): Promise<string | null> {
  try {
    await pool.query('DELETE FROM trip_plan_drafts WHERE expires_at < NOW()');
    const clean = redactPII(wishes ?? '').slice(0, 500) || null;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trip_plan_drafts (params, days, wishes, surface)
       VALUES ($1::jsonb, $2::jsonb, $3, $4)
       RETURNING id::text`,
      [JSON.stringify(plan.params), JSON.stringify(plan.days), clean, surface],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('черновик не записан', err);
    return null;
  }
}

export async function loadDraft(id: string): Promise<DraftRead> {
  if (!isDraftId(id)) return { kind: 'missing' };
  try {
    const { rows } = await pool.query<{ id: string; params: PlanParams; days: DayPlan[]; revision: number; expires_at: Date | string }>(
      `SELECT id::text, params, days, revision, expires_at
         FROM trip_plan_drafts
        WHERE id = $1::uuid AND expires_at > NOW()`,
      [id.trim()],
    );
    const r = rows[0];
    if (!r) return { kind: 'missing' };
    const expiresAt = r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at);
    return { kind: 'found', draft: { id: r.id, params: r.params, days: r.days, revision: r.revision, expiresAt } };
  } catch (err) {
    logFail('черновик не прочитан', err);
    return { kind: 'failed' };
  }
}

export type DraftWrite =
  | { kind: 'saved'; revision: number }
  | { kind: 'conflict' }
  | { kind: 'failed' };

/**
 * Записать правку новой ревизией. Ревизия сверяется: если черновик за это
 * время правили ещё раз (два агента на одном id) или он истёк, правка не
 * затирает чужую молча — `conflict`. Отказ базы — `failed`, это другое
 * (§4.0). Срок черновика продлевается: правят — значит, пользуются.
 */
export async function updateDraft(draft: PlanDraft, next: EditablePlan): Promise<DraftWrite> {
  try {
    const { rows } = await pool.query<{ revision: number }>(
      `UPDATE trip_plan_drafts
          SET params = $2::jsonb, days = $3::jsonb, revision = revision + 1,
              updated_at = NOW(), expires_at = NOW() + INTERVAL '7 days'
        WHERE id = $1::uuid AND revision = $4 AND expires_at > NOW()
        RETURNING revision`,
      [draft.id, JSON.stringify(next.params), JSON.stringify(next.days), draft.revision],
    );
    const r = rows[0];
    return r ? { kind: 'saved', revision: r.revision } : { kind: 'conflict' };
  } catch (err) {
    logFail('правка черновика не записана', err);
    return { kind: 'failed' };
  }
}
