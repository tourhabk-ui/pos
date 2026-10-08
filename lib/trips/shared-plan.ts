/**
 * Какой план открывает /trip/[token] — одно правило для страницы, её данных
 * и GPX (#2225).
 *
 * До 08.10 по этой ссылке открывался только план, который зарегистрированный
 * человек сохранил в /planner и опубликовал (`user_trips`, `share_token`). План
 * Кузьмича и внешнего агента в MCP оставался текстом в чате: ни карты, ни GPX,
 * ни способа открыть его в поле без сети. Теперь та же ссылка открывает и
 * черновик плана (#2224, миграция 1182) — по его id.
 *
 * Доступ в обоих случаях — знанием UUID: у опубликованной поездки это токен
 * публикации, у черновика — его id (у анонимного черновика нет владельца,
 * которого можно сверить, и угадать UUID нельзя). Пожелания туриста из
 * черновика сюда не читаются вовсе: странице они не нужны, а ссылку могут
 * переслать (pd-guard, «кто получит?»).
 *
 * Три исхода, как требует §4.0: план есть; плана нет (не было, не
 * опубликован, черновику больше 7 дней); прочитать не смогли. Третий не равен
 * второму: «не найдено» на отказ базы отправило бы человека собирать заново
 * план, который лежит на месте.
 */

import { pool } from '@/lib/db-pool';
import { loadDraft } from '@/lib/planner/plan-drafts';
import type { DayPlan } from '@/lib/planner/engine';

export interface SharedPlan {
  /** trip — опубликованная поездка из /planner; draft — черновик Кузьмича или MCP. */
  source: 'trip' | 'draft';
  id: string;
  title: string;
  arrival_date: string | null;
  departure_date: string | null;
  places: string[];
  activities: string[];
  days: unknown[];
  transport_by_day: Record<string, string>;
  /** Только у черновика: до какого момента живёт ссылка (ISO). */
  expires_at?: string;
  /**
   * Только у черновика: тур, который поставил в день сам план (номер дня →
   * id тура). Страница показывает его, а не «лучший тур по типу занятия»:
   * иначе в чате был бы один тур, а на странице того же плана — другой.
   */
  day_tour_ids?: Record<string, string>;
}

export type SharedPlanRead =
  | { kind: 'found'; plan: SharedPlan }
  | { kind: 'missing' }
  | { kind: 'failed' };

const TOKEN_RE = /^[0-9a-f-]{36}$/i;

/** «5 дней», «2 дня», «1 день». */
function daysWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

export function draftTitle(dayCount: number): string {
  return `План поездки по Камчатке на ${dayCount} ${daysWord(dayCount)}`;
}

export async function readSharedPlan(token: string): Promise<SharedPlanRead> {
  if (!TOKEN_RE.test(token)) return { kind: 'missing' };

  try {
    const { rows } = await pool.query<{
      id: string; title: string; arrival_date: string | null; departure_date: string | null;
      places: string[]; activities: string[]; days: unknown; transport_by_day: unknown;
    }>(
      `SELECT id, title, arrival_date, departure_date, places, activities, days, transport_by_day
       FROM user_trips
       WHERE share_token = $1 AND is_public = TRUE AND deleted_at IS NULL`,
      [token],
    );
    const r = rows[0];
    if (r) {
      return {
        kind: 'found',
        plan: {
          ...r,
          source: 'trip',
          days: Array.isArray(r.days) ? r.days : [],
          transport_by_day: (r.transport_by_day && typeof r.transport_by_day === 'object' ? r.transport_by_day : {}) as Record<string, string>,
        },
      };
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[shared-plan] опубликованная поездка не прочитана', { sqlstate: e?.code, message: e?.message });
    return { kind: 'failed' };
  }

  const read = await loadDraft(token);
  if (read.kind !== 'found') return read;
  const { draft } = read;
  const days = Array.isArray(draft.days) ? draft.days : [];
  const dayTourIds: Record<string, string> = {};
  for (const d of days as DayPlan[]) {
    if (d.realTour?.tourId && typeof d.day === 'number') dayTourIds[String(d.day)] = String(d.realTour.tourId);
  }
  return {
    kind: 'found',
    plan: {
      source: 'draft',
      id: draft.id,
      title: draftTitle(days.length),
      arrival_date: draft.params.arrivalDate ?? null,
      departure_date: draft.params.departureDate ?? null,
      places: [],
      activities: draft.params.interests ?? [],
      days,
      transport_by_day: {},
      ...(draft.expiresAt ? { expires_at: draft.expiresAt } : {}),
      day_tour_ids: dayTourIds,
    },
  };
}
