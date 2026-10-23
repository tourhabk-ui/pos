/**
 * my_tours_schedule — свои туры оператора и открытые даты по ним, для
 * Кузьмича в привязанном чате оператора (MAX, Telegram).
 *
 * Владелец 24.10 («разве это мы планировали?»): оператор спросил в MAX
 * «какие даты открыты?», а помощник ответил, что инструменты расписания не
 * возвращают и туров нет. Инструментов про туры у него не было вовсе — только
 * CRM. Здесь — свои туры оператора ЦЕЛИКОМ, включая скрытые с витрины
 * (is_published = false): это его собственные туры, не выдача туристу, и
 * шлюз витрины (publicTourSql) к ним не относится. Оператор — из
 * привязанного чата, не из аргументов модели: чужой тур не найти.
 *
 * Занятость — ТОЛЬКО fetchAvailabilityForTour (тот же расчёт, что у гейта
 * брони); свой SQL по tour_availability запрещён — разойдётся с гейтом.
 */

import { pool } from '@/lib/db-pool';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { containsPattern } from '@/lib/db/like';
import { kamchatkaToday } from '@/lib/seat-requests/core';

export const MY_TOURS_TOOL_NAME = 'my_tours_schedule';

export const MY_TOURS_TOOL = {
  type: 'function' as const,
  function: {
    name: MY_TOURS_TOOL_NAME,
    description:
      'Свои туры оператора (включая скрытые с витрины и неактивные) и открытые даты со свободными местами по каждому. '
      + 'Зови на «мои туры», «какие даты открыты», «сколько мест на субботу».',
    parameters: {
      type: 'object',
      properties: {
        tour: { type: 'string', description: 'Необязательно: часть названия или номер тура' },
        days: { type: 'string', description: 'Необязательно: на сколько дней вперёд смотреть, 1–120 (по умолчанию 60)' },
      },
    },
  },
};

const TOURS_LIMIT = 10;
const DATES_LIMIT = 20;

interface OwnTour {
  id: number;
  title: string;
  is_active: boolean;
  is_published: boolean;
  max_participants: number | null;
  season_start: string | null;
  season_end: string | null;
}

export function parseDays(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.min(n, 120);
}

/** Текст для модели. Отказ базы — «не смог проверить», не «дат нет» (§4.0). */
export async function runMyToursSchedule(
  partnerId: string,
  args: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<string> {
  const q = typeof args.tour === 'string' ? args.tour.trim().slice(0, 100) : '';
  const days = parseDays(args.days);

  let tours: OwnTour[];
  try {
    const { rows } = await pool.query<OwnTour>(
      `SELECT id, title, is_active, is_published, max_participants,
              season_start::text, season_end::text
         FROM operator_tours
        WHERE operator_id = $1::uuid
          AND deleted_at IS NULL
          AND ($2::text = '' OR id::text = $2::text OR title ILIKE $3::text)
        ORDER BY is_active DESC, created_at DESC
        LIMIT ${TOURS_LIMIT}`,
      [partnerId, q, containsPattern(q)],
    );
    tours = rows;
  } catch (err) {
    console.error('[my-tours] туры оператора не прочитаны, SQLSTATE', (err as { code?: string })?.code ?? 'нет');
    return 'НЕ УДАЛОСЬ ПРОЧИТАТЬ туры оператора — не утверждай, что туров или дат нет; предложи спросить позже.';
  }
  if (tours.length === 0) {
    return q ? `Среди туров оператора нет подходящего под «${q}».` : 'У оператора нет ни одного тура (удалённые не считаются).';
  }

  const from = kamchatkaToday(nowMs);
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);
  const cache = createPlannerCache();
  const lines = [`Туры оператора и открытые даты с ${from} по ${to} (свободные места — с учётом броней):`];
  for (const t of tours) {
    const flags = [t.is_active ? 'активен' : 'неактивен', t.is_published ? 'на витрине' : 'скрыт с витрины'];
    const season = t.season_start || t.season_end ? ` | сезон ${t.season_start ?? '…'} — ${t.season_end ?? '…'}` : '';
    lines.push(`- ID${t.id} «${t.title}» | ${flags.join(', ')}${t.max_participants ? ` | до ${t.max_participants} чел` : ''}${season}`);
    try {
      const slots = await fetchAvailabilityForTour(String(t.id), from, to, cache);
      if (slots.length === 0) {
        lines.push('  Открытых дат со свободными местами нет: расписание в этом окне не заведено или места разобраны. '
          + 'Без расписания запросы мест всё равно принимаются по сезону.');
      } else {
        const shown = slots.slice(0, DATES_LIMIT).map((s) => `${s.date}: свободно ${s.remaining}`).join('; ');
        lines.push(`  ${shown}${slots.length > DATES_LIMIT ? `; и ещё ${slots.length - DATES_LIMIT} дат` : ''}`);
      }
    } catch {
      lines.push('  Даты НЕ УДАЛОСЬ ПРОВЕРИТЬ — не утверждай, что их нет.');
    }
  }
  return lines.join('\n');
}
