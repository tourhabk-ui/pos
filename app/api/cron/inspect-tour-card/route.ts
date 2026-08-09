/**
 * GET /api/cron/inspect-tour-card?tour=6
 *
 * Форма данных карточки тура на ПРОДЕ — типы и имена ключей, без значений.
 *
 * Зачем. За 08–09.08 трижды сработал один класс дефекта: схема в миграциях
 * расходится со схемой на проде, а код глотает разницу молча (фантомная
 * колонка в каталоге, `is_visible` в sitemap, теперь — контакты партнёра,
 * приезжающие строкой вместо объекта). Разбирать такое по HTML безнадёжно:
 * во флайт-пейлоаде Next строка бьётся на куски по произвольным границам, и
 * `"ключ":{` может не найтись, хотя объект на месте. Этот роут отвечает на
 * вопрос прямо: чем колонка ОБЪЯВЛЕНА в базе и чем значение приходит в код.
 *
 * 152-ФЗ. Наружу уходят только типы, имена ключей и длины — ни одного
 * значения: в `partners.contacts` лежат телефоны, а лог Actions читается за
 * границей. Список ключей — это имена полей, не персональные данные.
 *
 * Read-only: единственный запрос — SELECT. Секрет-гейт как у прочих
 * cron-диагностик.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { getTourForCard, toContactsRecord } from '@/lib/tours/tour-detail-query';

export const dynamic = 'force-dynamic';

interface ShapeRow {
  contacts_pg_type: string | null;
  logo_pg_type: string | null;
  contacts_raw_kind: string | null;
  has_logo: boolean | null;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tour = req.nextUrl.searchParams.get('tour') ?? '6';
  if (!/^\d{1,10}$/.test(tour)) {
    return NextResponse.json({ error: 'tour — числовой ID' }, { status: 400 });
  }

  try {
    // pg_typeof отвечает на главный вопрос: JSONB колонка или текстовая.
    // `jsonb_typeof` — уточнение на случай JSON-строки внутри jsonb.
    const { rows } = await pool.query<ShapeRow>(
      `SELECT
         pg_typeof(p.contacts)::text   AS contacts_pg_type,
         pg_typeof(p.logo_image)::text AS logo_pg_type,
         CASE
           WHEN p.contacts IS NULL THEN 'null'
           WHEN pg_typeof(p.contacts)::text IN ('jsonb', 'json')
             THEN jsonb_typeof(p.contacts::jsonb)
           ELSE 'not-json-column'
         END                            AS contacts_raw_kind,
         (p.logo_image IS NOT NULL AND length(p.logo_image) > 0) AS has_logo
       FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
       WHERE ot.id = $1`,
      [tour],
    );

    if (rows.length === 0) {
      return NextResponse.json({ tour, found: false }, { status: 404 });
    }

    // Что реально получает карточка — тем же путём, каким её кормит страница.
    const row = await getTourForCard(Number(tour));
    const normalized = row?.operator_contacts ?? null;
    // Второй проход по сырому значению: показывает, СРАБОТАЛ ли разбор строки.
    const rawParsed = toContactsRecord(normalized);

    return NextResponse.json({
      tour,
      found: true,
      db: rows[0],
      app: {
        row_found: row !== null,
        contacts_typeof: typeof normalized,
        contacts_is_null: normalized === null,
        contacts_keys: normalized ? Object.keys(normalized).sort() : [],
        contacts_parsed_keys: rawParsed ? Object.keys(rawParsed).sort() : [],
        operator_logo_present: Boolean(row?.operator_logo),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
