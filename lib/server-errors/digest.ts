/**
 * lib/server-errors/digest.ts — суточный дайджест серверных ошибок владельцу.
 *
 * Находка аудита 15.10 P4-17: серверные ошибки прода доходили до владельца
 * только через суточный объектив эволюции и GitHub Issue — то есть сутки
 * спустя и не ему, а Claude в репозитории. У ошибок браузера суточный
 * дайджест в Telegram был с 13.10, у серверных — нет, хотя журнал
 * (`instrumentation.onRequestError` → `ai_actions_log`) и перепись
 * (`/api/cron/prod-errors`) уже были написаны. Дайджест шлёт сама перепись по
 * `?notify=1`, вторым шагом того же суточного workflow, что и браузерный.
 *
 * Два правила, оба проверяются вызовом (tests/unit/prod-errors-digest.test.ts):
 *
 *  1. ПД в Telegram не уходят. Решение владельца 23.08: персональные данные —
 *     только в контуре РФ, в Telegram — номер дела и ссылка
 *     (docs/safety/WATCH_DESIGN.md, lib/notifications/pd-alert.ts). Текст
 *     ошибки бывает каким угодно: почта из формы, телефон в ключе уникальности,
 *     адрес с ключом в query. Он чистится на входе (Д4-4, тот же аудит), а
 *     здесь — ещё раз: строки, записанные до 15.10, не чистил никто. В
 *     дайджест идут шаблон маршрута, счётчик и короткий очищенный текст; стек
 *     и конкретные адреса — нет.
 *
 *  2. Счётчики — нижняя граница, и это сказано словами (§4.0). Перехватчик
 *     пишет повтор ошибки на маршруте не чаще раза в `ERROR_LOG_THROTTLE_MS`,
 *     а перепись отдаёт не больше `ROUTE_LIMIT` маршрутов. «3 ошибки» без
 *     этой оговорки читалось бы как точное число.
 */

import { stripPathToken } from '@/lib/analytics/token-path';
import { scrubErrorText } from '@/lib/client-errors/scrub';
import { escapeHtml } from '@/lib/text/escape-html';
import { ERROR_LOG_THROTTLE_MS } from '@/lib/server-errors/log-throttle';

/** Сколько маршрутов отдаёт перепись — тот же потолок, что `LIMIT` её запроса. */
export const ROUTE_LIMIT = 50;
/** Сколько маршрутов показывает дайджест поимённо. */
export const DIGEST_TOP = 5;

const THROTTLE_SEC = Math.round(ERROR_LOG_THROTTLE_MS / 1000);

/** Оговорка к счётчикам переписи — в ответ JSON, тем же числом, что действует. */
export const LOWER_BOUND_NOTE =
  `Счётчики — нижняя граница: повтор ошибки на одном маршруте пишется не чаще раза в ${THROTTLE_SEC} с, ` +
  `а маршрутов отдаётся не больше ${ROUTE_LIMIT}.`;

export interface ServerErrorRow {
  route: string | null;
  method: string | null;
  kind: string | null;
  n: number;
  first_at: string;
  last_at: string;
  last_message: string | null;
  paths: string[] | null;
  last_digest: string | null;
  last_stack: string | null;
  /**
   * Строки этой группы — обрыв соединения, а не ошибка страницы
   * (`lib/server-errors/connection-abort.ts`). Перепись группирует по
   * маршруту И этому признаку, поэтому у одного маршрута бывает две строки.
   */
  connection_abort?: boolean;
}

/** Маршрут без query и фрагмента: без шаблона (`routePath`) туда попадал сырой адрес. */
function routeOnly(route: string): string {
  return scrubErrorText(stripPathToken(route.split(/[?#]/)[0]), 200) || 'unknown';
}

/**
 * Строка переписи после повторной чистки. Нужна для строк, записанных до
 * чистки на входе (15.10): они живут в журнале, пока его не подчистят, и
 * уходят в ответ переписи и в лог прогона workflow.
 */
export function scrubServerErrorRow(r: ServerErrorRow): ServerErrorRow {
  return {
    ...r,
    n: Number(r.n),
    connection_abort: r.connection_abort === true,
    route: r.route === null ? null : routeOnly(r.route),
    last_message: r.last_message === null ? null : scrubErrorText(r.last_message, 300),
    last_stack: r.last_stack === null ? null : (scrubErrorText(r.last_stack, 400) || null),
    paths: r.paths === null ? null : r.paths.map((p) => scrubErrorText(stripPathToken(String(p).split(/[?#]/)[0]), 200)),
  };
}

/**
 * Текст дайджеста для Telegram (HTML). Пустой список сюда не передаётся:
 * «ошибок нет» решает вызывающий и не шлёт ничего.
 *
 * Обрывы соединения в счёт ошибок не входят: о них одна строка в конце —
 * сколько и на каких маршрутах, со словами, что страница не падала.
 *
 * @param truncated перепись упёрлась в `ROUTE_LIMIT` — маршрутов могло быть больше
 * @param aborts строки переписи с признаком `connection_abort`
 */
export function serverErrorsDigestText(
  hours: number, rows: ServerErrorRow[], truncated: boolean, aborts: ServerErrorRow[] = [],
): string {
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const routes = truncated ? `не меньше ${rows.length}` : String(rows.length);
  const lines: string[] = [];
  lines.push(`<b>Ошибки сервера за ${hours} ч</b>: не меньше ${total}, маршрутов ${routes}`);
  lines.push(`Повтор ошибки на одном маршруте пишется не чаще раза в ${THROTTLE_SEC} с, поэтому все числа — нижняя граница.`);
  rows.slice(0, DIGEST_TOP).forEach((r, i) => {
    const route = routeOnly(r.route ?? 'unknown');
    const how = [r.kind, r.method].filter((x): x is string => Boolean(x)).join(', ');
    const msg = r.last_message ? scrubErrorText(r.last_message, 140) : '';
    lines.push(
      `${i + 1}. ${escapeHtml(route)}${how ? ` (${escapeHtml(how)})` : ''} — не меньше ${Number(r.n)}` +
      `${msg ? `: ${escapeHtml(msg)}` : ', текст не записан'}`,
    );
  });
  if (rows.length > DIGEST_TOP) {
    lines.push(`Остальные маршруты: ${truncated ? 'не меньше ' : ''}${rows.length - DIGEST_TOP}.`);
  }
  const abortLine = connectionAbortsLine(aborts);
  if (abortLine) lines.push(escapeHtml(abortLine));
  lines.push('Стеки и адреса здесь не показываются — они в переписи /api/cron/prod-errors.');
  return lines.join('\n').slice(0, 3500);
}

/**
 * Одна строка об обрывах соединения — для дайджеста и для ответа переписи.
 * Обрывов нет — `null`: строки нет, а не «0 обрывов».
 */
export function connectionAbortsLine(aborts: readonly ServerErrorRow[]): string | null {
  if (aborts.length === 0) return null;
  const n = aborts.reduce((s, r) => s + Number(r.n), 0);
  const routes = [...new Set(aborts.map((r) => routeOnly(r.route ?? 'unknown')))];
  const shown = routes.slice(0, DIGEST_TOP).join(', ');
  const more = routes.length > DIGEST_TOP ? ` и ещё ${routes.length - DIGEST_TOP}` : '';
  return `Обрывы соединения: не меньше ${n} (${shown}${more}). ` +
    'Посетитель ушёл или связь оборвалась, пока сервер дописывал ответ; страница не падала, в счёт ошибок не входят.';
}
