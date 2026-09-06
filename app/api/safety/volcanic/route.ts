/**
 * GET /api/safety/volcanic
 * Публичный. Возвращает последние вулканические события из external_alerts.
 *
 * Окно намеренно шире срока действия (семь дней): человеку, который вышел на
 * маршрут вчера, полезно видеть, что происходило на неделе, а не только то,
 * что горит прямо сейчас. Отсюда два обязательства этого роута.
 *
 * ПЕРВОЕ: одна угроза — одна строка. Суточная сводка ГУ МЧС публикуется каждый
 * день новым постом с тем же текстом, и в базе накапливаются строки, которые
 * различаются только id и датой. Дедуп при вставке (saveEvent) ловит лишь
 * повтор при ЖИВОМ оригинале — а в семидневном окне рядом оказываются и
 * истёкшие. Проба прода 10.08: «Сохраняется риск схода оползней и обвалов с
 * вулкана Мутновского» пришёл СЕМЬ раз подряд. Ровно этот дефект владелец
 * снимал 01.08, когда он висел трижды; тогда починили счётчик, дверь осталась.
 *
 * ВТОРОЕ: истёкшее названо истёкшим. Предупреждение недельной давности,
 * нарисованное так же, как сегодняшнее, — это не история, это дезинформация:
 * человек читает «риск обвалов» и не знает, про сегодня оно или про прошлый
 * вторник.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
// Время проверки — общее правило на все ленты (lib/safety/ingest-run):
// «когда спрашивали» считается по прогону приёма, а не по возрасту записи.
import { lastIngestAt } from '@/lib/safety/ingest-run';

export const dynamic = 'force-dynamic';

export interface VolcanicEvent {
  id: string;
  title: string;
  description: string | null;
  severity: number;
  affected_zones: string[];
  created_at: string;
  expires_at: string | null;
  source_url: string | null;
  /** Действует ли предупреждение сейчас. false — показано как история. */
  active: boolean;
}

export async function GET() {
  try {
    // DISTINCT ON схлопывает повторы по СОДЕРЖАНИЮ, оставляя свежайший:
    // именно он несёт актуальный срок действия и ссылку на последний пост.
    // Ключ регистронезависимый — тем же приёмом схлопывается лента главной
    // (app/_home/data.ts): один и тот же пункт сводки, перенабранный с другой
    // заглавной, иначе разошёлся бы на две строки.
    const { rows } = await pool.query<VolcanicEvent>(`
      SELECT * FROM (
        SELECT DISTINCT ON (lower(title), lower(COALESCE(description, '')))
          id::text,
          title,
          description,
          severity,
          COALESCE(affected_zones, ARRAY[]::TEXT[]) AS affected_zones,
          created_at,
          expires_at,
          source_url,
          (expires_at IS NULL OR expires_at > NOW()) AS active
        FROM external_alerts
        WHERE alert_type = 'volcanic_eruption'
          AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '7 days')
        ORDER BY lower(title), lower(COALESCE(description, '')), created_at DESC
      ) u
      ORDER BY active DESC, created_at DESC
      LIMIT 20
    `);

    return NextResponse.json({ events: rows, checked_at: await lastIngestAt() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ events: [], checked_at: null, error: msg });
  }
}
