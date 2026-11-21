/**
 * GET /api/admin/analytics/visits-export?hours=48 — журнал просмотров сайта
 * файлом CSV, только администратору (21.11, владелец: «выгрузить … за 48
 * часов для Сыщика», вариант 1 — «1 сейчас»).
 *
 * Access-лога у платформы нет: сервер запросы не пишет, а `page_views` по
 * решению 152-ФЗ хранит не IP и User-Agent, а суточные хэши, семейство
 * браузера и класс устройства. Выгрузка отдаёт ровно это, построчно:
 *   время (UTC и по Камчатке), путь без параметров, страница не найдена,
 *   бот / аномалия по адресу / свой заход, маяк браузера, семейство
 *   браузера или робота, класс устройства, хост источника (не ссылка —
 *   в ней бывают поисковые запросы и данные человека), предыдущая страница
 *   без параметров, видимое время, номер визита.
 * Чего нет: IP, полного User-Agent, хэшей, кук, параметров адреса.
 * Номер визита — случайный идентификатор вкладки, не человек; он нужен,
 * чтобы видеть путь по сайту внутри визита.
 *
 * Только администратор (`requireAdmin`): построчный журнал поведения не
 * кладётся ни в публичный лог workflow, ни в репозиторий. CSV — через
 * `toCSV` с защитой от формульной инъекции (путь и семейство пишет внешний
 * мир).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { toCSV } from '@/lib/operator/csv';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_HOURS = 48;
const MAX_HOURS = 168;
/** Потолок строк: больше Excel откроет, но файл перестанет быть разбором. */
export const MAX_ROWS = 50_000;

export const EXPORT_SQL = `
  SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS time_utc,
         to_char(created_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD HH24:MI:SS') AS time_kamchatka,
         split_part(split_part(path, '?', 1), '#', 1) AS path,
         is_not_found, is_bot, anomaly_bot, is_self, client_beacon,
         ua_family, device,
         substring(referrer from '^[a-z]+://([^/?#]+)') AS referrer_host,
         split_part(split_part(from_path, '?', 1), '#', 1) AS from_path,
         dwell_ms, session_id
    FROM page_views
   WHERE created_at >= NOW() - make_interval(hours => $1::int)
   ORDER BY created_at
   LIMIT $2`;

export const HEADERS: Record<string, string> = {
  time_utc: 'Время UTC',
  time_kamchatka: 'Время по Камчатке',
  path: 'Путь',
  is_not_found: 'Не найдено',
  is_bot: 'Бот',
  anomaly_bot: 'Аномалия по адресу',
  is_self: 'Свой заход',
  client_beacon: 'Маяк браузера',
  ua_family: 'Браузер или робот',
  device: 'Устройство',
  referrer_host: 'Источник (хост)',
  from_path: 'Предыдущая страница',
  dwell_ms: 'Видимое время, мс',
  session_id: 'Визит',
};

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const raw = Number(new URL(request.url).searchParams.get('hours') ?? DEFAULT_HOURS);
  const hours = Number.isFinite(raw) ? Math.min(MAX_HOURS, Math.max(1, Math.round(raw))) : DEFAULT_HOURS;

  try {
    const res = await pool.query<Record<string, unknown>>(EXPORT_SQL, [hours, MAX_ROWS + 1]);
    const truncated = res.rows.length > MAX_ROWS;
    const rows = truncated ? res.rows.slice(0, MAX_ROWS) : res.rows;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return new NextResponse(toCSV(rows, HEADERS), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vedar-visits-${hours}h-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        // Обрезано по потолку — сказано заголовком, а не молчанием.
        'X-Rows': String(rows.length),
        'X-Truncated': truncated ? 'true' : 'false',
      },
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[admin/visits-export] журнал не прочитался:', `SQLSTATE=${e?.code ?? 'нет'}`, (e?.message ?? '').slice(0, 200));
    return NextResponse.json({ error: 'Журнал просмотров не прочитался — попробуйте через минуту' }, { status: 503 });
  }
}
