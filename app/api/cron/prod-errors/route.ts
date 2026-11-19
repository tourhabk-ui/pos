/**
 * GET /api/cron/prod-errors — серверные ошибки прода списком, по требованию.
 *
 * Ошибки собираются давно: `instrumentation.onRequestError` пишет каждую в
 * `ai_actions_log` (`action_type='server_error'`, с троттлингом по маршруту).
 * Но читал их только объектив эволюции — раз в сутки, превращая в находки.
 * Посмотреть, что происходит ПРЯМО СЕЙЧАС, было нельзя: ни владельцу, ни
 * Claude в репозитории. Из-за этого разговор об ошибках упирался в ощущения —
 * «вроде много», — а не в список маршрутов со счётчиками.
 *
 * Базу роут только читает и ничего не чинит: находка — повод посмотреть, а не
 * переписать данные. Живёт под /api/cron/ по одной причине — проба прода несёт
 * CRON_SECRET только на этот префикс (сужено 09.08 после утечки секрета на
 * сторонний хост), и другого способа увидеть прод из песочницы нет.
 *
 * Окно задаётся `?hours=` (по умолчанию 25 — как у суточного объектива, с
 * запасом на дрейф расписания). `?route=` сужает до одного маршрута.
 *
 * `?notify=1` (находка аудита 15.10 P4-17) — суточный дайджест владельцу в
 * Telegram через tgSend. Зовёт его вторым шагом `cron-client-errors.yml` — тот
 * же файл, что шлёт дайджест ошибок браузера, а не новое расписание (§8:
 * планировщик GitHub душит очередь числом scheduled-файлов). Три исхода:
 * доставлен; «ошибок нет» — не шлётся ничего; не доставлен — ответ `ok: false`
 * и 502, а не зелёный прогон (§4.0). Текст и стек чистятся на выходе ещё раз
 * (Д4-4): строки до 15.10 записаны без чистки, а ПД в Telegram не уходят
 * (решение владельца 23.08). Счётчики — нижняя граница, см.
 * `lib/server-errors/digest.ts`.
 *
 * Обрыв соединения (слово владельца 19.11 «1») — не ошибка: посетитель ушёл
 * посреди ответа, стек целиком во внутренностях Node.js. Такие строки идут
 * отдельным списком `connection_aborts`, в `total` не входят, а в дайджесте
 * о них одна строка; если кроме них ничего нет, дайджест не шлётся.
 * Признак — `lib/server-errors/connection-abort.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { tgSend } from '@/lib/notifications/tg-send';
import {
  LOWER_BOUND_NOTE, ROUTE_LIMIT, connectionAbortsLine, scrubServerErrorRow, serverErrorsDigestText,
  type ServerErrorRow,
} from '@/lib/server-errors/digest';
import { CONNECTION_ABORT_SQL } from '@/lib/server-errors/connection-abort';

export const dynamic = 'force-dynamic';

const SCOPE = 'prod-errors';

interface NotifyOutcome { sent: boolean; reason: string }

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Окно ограничено сверху неделей: запрос за месяц по журналу действий —
  // это полный скан таблицы, которая пишется на каждое действие платформы.
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') ?? 25) || 25));
  const route = url.searchParams.get('route');
  const notify = url.searchParams.get('notify') === '1';

  try {
    const { rows } = await pool.query<ServerErrorRow>(
      `SELECT metadata->>'route'  AS route,
              -- Обрыв соединения — своя строка у маршрута, а не ошибка.
              ${CONNECTION_ABORT_SQL} AS connection_abort,
              STRING_AGG(DISTINCT metadata->>'method', '/') AS method,
              STRING_AGG(DISTINCT metadata->>'kind', '/')   AS kind,
              COUNT(*)::int AS n,
              MIN(created_at)::text AS first_at,
              MAX(created_at)::text AS last_at,
              (ARRAY_AGG(metadata->>'message' ORDER BY created_at DESC))[1] AS last_message,
              -- Конкретные адреса и digest (с 03.10): без них замазанная
              -- ошибка рендера не воспроизводится. Старые строки — NULL.
              (ARRAY_REMOVE(ARRAY_AGG(DISTINCT metadata->>'path'), NULL))[1:10] AS paths,
              (ARRAY_AGG(metadata->>'digest' ORDER BY created_at DESC))[1] AS last_digest,
              (ARRAY_AGG(metadata->>'stack' ORDER BY created_at DESC))[1] AS last_stack
         FROM ai_actions_log
        WHERE action_type = 'server_error'
          AND created_at > NOW() - make_interval(hours => $1)
          AND ($2::text IS NULL OR metadata->>'route' = $2)
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 50`,
      [hours, route],
    );

    const all = rows.map(scrubServerErrorRow);
    const errors = all.filter((r) => !r.connection_abort);
    const aborts = all.filter((r) => r.connection_abort);
    const total = errors.reduce((s, r) => s + r.n, 0);
    // Упёрлись в потолок запроса — маршрутов могло быть больше.
    const truncated = all.length >= ROUTE_LIMIT;

    let notifyOutcome: NotifyOutcome | null = null;
    if (notify) {
      if (errors.length === 0) {
        // Тишина в Telegram значит «ошибок нет» — и это видно по ответу,
        // а не угадывается по отсутствию сообщения. Одни обрывы соединения
        // владельца не будят: страница не падала.
        notifyOutcome = {
          sent: false,
          reason: aborts.length > 0 ? 'ошибок нет, только обрывы соединения' : 'ошибок нет',
        };
      } else {
        const out = await tgSend(SCOPE, serverErrorsDigestText(hours, errors, truncated, aborts));
        notifyOutcome = out.ok ? { sent: true, reason: 'доставлен' } : { sent: false, reason: out.reason };
      }
    }

    const body = {
      hours,
      routes: errors.length,
      total,
      total_is_lower_bound: true,
      truncated,
      note: LOWER_BOUND_NOTE,
      notify: notifyOutcome,
      // Пусто — это ответ, а не отсутствие ответа: за окно ошибок не было.
      errors,
      // Обрывы соединения отдельно: в `total` и `routes` не входят.
      connection_aborts: aborts,
      connection_aborts_total: aborts.reduce((s, r) => s + r.n, 0),
      connection_aborts_note: connectionAbortsLine(aborts),
    };
    if (notifyOutcome !== null && !notifyOutcome.sent && errors.length > 0) {
      // Дайджест собран, а владелец его не получил: прогон не «ок», иначе
      // недоставка выглядела бы как спокойные сутки (§4.0).
      return NextResponse.json({ ok: false, ...body }, { status: 502 });
    }
    return NextResponse.json({ ok: true, ...body });
  } catch (err) {
    // Наружу — причина: роут закрыт секретом, скрывать от себя же нечего, а
    // «пусто» вместо сбоя запроса — ровно та подмена, из-за которой оценка
    // риска по зонам молчала месяцами.
    const message = err instanceof Error ? err.message : 'unknown';
    const code = (err as { code?: string })?.code ?? 'нет';
    console.error(`[${SCOPE}] перепись не выполнилась (SQLSTATE ${code}):`, message);
    return NextResponse.json({
      ok: false,
      error: message,
      notify: notify ? { sent: false, reason: 'перепись не выполнилась — слать нечего' } : null,
    }, { status: 500 });
  }
}
