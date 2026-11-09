/**
 * Перепись Вебмастера с раннера GitHub (09.11): откуда брать токен и что
 * печатать в журнал.
 *
 * На проде токена нет (prod-check 169: среди переменных про Яндекс только
 * `YANDEX_API_KEY` и `YANDEX_FOLDER_ID`). Владелец 08.11: «в githab» — токен в
 * секретах репозитория. Ни один workflow его не читает, имени не знает никто,
 * а перечислить секреты workflow не может: `toJSON(secrets)` отдал бы шагу ВСЕ
 * секреты репозитория. Поэтому workflow кладёт в окружение секреты по списку
 * правдоподобных имён с приставкой `WM_SECRET__`; отсюда собирается окружение
 * для `webmasterCensus` с именами `secrets.<ИМЯ>`.
 *
 * Переменные репозитория (`vars`) не читаются: прогон 1 клал их строкой JSON,
 * и раннер напечатал её в публичный журнал целиком — vars не маскируются, и
 * токен, положенный туда по ошибке, ушёл бы в журнал открытым текстом.
 *
 * Журнал прогона в публичном репозитории читает кто угодно, поэтому в него
 * идёт сводка, а не всё: ни значения токена, ни чужих сайтов аккаунта.
 */

import type { CensusResult } from './webmaster-census';

export const SECRET_PREFIX = 'WM_SECRET__';

/**
 * Окружение для поиска токена: `secrets.<ИМЯ>` из непустых `WM_SECRET__<ИМЯ>`.
 * Пустые не попадают: GitHub отдаёт отсутствующий секрет пустой строкой, и
 * список «есть такие имена» иначе состоял бы из всего, что мы угадывали.
 */
export function runnerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(SECRET_PREFIX)) continue;
    if ((value ?? '').trim().length === 0) continue;
    out[`secrets.${name.slice(SECRET_PREFIX.length)}`] = value as string;
  }
  return out;
}

const fmt = (v: number | null) => (v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && key in obj ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Сводка для журнала: строки markdown. Каждый раздел — данные или отказ
 * словами; раздела, до которого перепись не дошла, нет, и это сказано.
 */
export function censusDigest(r: CensusResult, opts: { topQueries: number; examples: number }): string[] {
  const out: string[] = ['## Перепись Яндекс Вебмастера', ''];
  if (r.token.found_as) {
    out.push(`Токен: принят — \`${r.token.found_as}\`.`);
  } else {
    out.push('Токен: **не найден или не принят**.');
  }
  for (const t of r.token.tried) out.push(`- проверен \`${t.name}\`: ${t.result}`);
  if (!r.token.found_as) {
    out.push(r.token.yandex_names.length
      ? `- имена про Яндекс и Вебмастер, что есть: ${r.token.yandex_names.map((n) => `\`${n}\``).join(', ')}`
      : '- ни один из проверенных секретов не задан — у токена другое имя');
    return out;
  }

  out.push('');
  if (!r.hosts) {
    out.push('Сайты аккаунта: не читались.');
    return out;
  }
  if (!r.hosts.ok) {
    out.push(`Сайты аккаунта: **не прочитались** — ${r.hosts.error}.`);
    return out;
  }
  const site = r.hosts.data.site;
  if (!site) {
    out.push(`Сайты аккаунта: ${r.hosts.data.total}, **нашего среди них нет** — сайт не добавлен в этот аккаунт Вебмастера.`);
    return out;
  }
  const verified = site.verified === true ? 'права подтверждены' : site.verified === false ? '**права не подтверждены**' : 'подтверждение не названо';
  out.push(`Сайт: ${site.url} (${verified}); всего сайтов в аккаунте ${r.hosts.data.total}.`);

  out.push('', '### Сводка');
  if (!r.summary) out.push('Не читалась.');
  else if (!r.summary.ok) out.push(`**Не прочиталась** — ${r.summary.error}.`);
  else {
    const s = r.summary.data;
    out.push(`- в поиске: ${String(pick(s, 'searchable_pages_count') ?? 'не названо')}`);
    out.push(`- исключено: ${String(pick(s, 'excluded_pages_count') ?? 'не названо')}`);
    out.push(`- ИКС: ${String(pick(s, 'sqi') ?? 'не назван')}`);
    out.push(`- проблемы сайта: \`${JSON.stringify(pick(s, 'site_problems') ?? null)}\``);
  }

  out.push('', '### Исключённые страницы (последние события)');
  if (!r.excluded) out.push('Не читались.');
  else if (!r.excluded.ok) out.push(`**Не прочитались** — ${r.excluded.error}.`);
  else {
    const e = r.excluded.data;
    out.push(`Событий всего: ${String(e.events_total ?? 'не названо')}; в выборке исключений: ${e.removed_in_sample}.`);
    if (e.by_reason.length === 0) out.push('Исключений в выборке нет.');
    for (const g of e.by_reason) {
      out.push(`- ${g.reason}: ${g.count} — ${g.examples.slice(0, opts.examples).join(', ')}`);
    }
  }

  out.push('', '### Страницы в поиске (выборка)');
  if (!r.in_search) out.push('Не читались.');
  else if (!r.in_search.ok) out.push(`**Не прочитались** — ${r.in_search.error}.`);
  else {
    out.push(`Всего: ${String(r.in_search.data.total ?? 'не названо')}; в выборке ${r.in_search.data.urls.length}.`);
    for (const u of r.in_search.data.urls.slice(0, opts.examples)) out.push(`- ${u}`);
  }

  out.push('', '### Запросы с показами');
  if (!r.queries) out.push('Не читались.');
  else if (!r.queries.ok) out.push(`**Не прочитались** — ${r.queries.error}.`);
  else {
    const q = r.queries.data;
    out.push(`Окно: ${String(q.date_from ?? '?')} — ${String(q.date_to ?? '?')}; запросов всего: ${String(q.total ?? 'не названо')}.`);
    if (q.top.length === 0) out.push('Запросов с показами нет.');
    else {
      out.push('', '| Запрос | Показы | Клики | Позиция показа | Позиция клика |', '|---|---|---|---|---|');
      for (const row of q.top.slice(0, opts.topQueries)) {
        out.push(`| ${row.query.replace(/\|/g, '/')} | ${fmt(row.shows)} | ${fmt(row.clicks)} | ${fmt(row.show_pos)} | ${fmt(row.click_pos)} |`);
      }
    }
  }
  return out;
}

/**
 * Исход прогона: красный — когда переписи не случилось (нет токена, нет сайта,
 * не прочитался ни один раздел). Часть разделов не прочиталась — жёлтый.
 */
export function censusOutcome(r: CensusResult): { level: 'ok' | 'warning' | 'error'; message: string } {
  if (!r.token.found_as) return { level: 'error', message: 'токен Вебмастера не найден среди проверенных имён или не принят API' };
  if (!r.hosts?.ok) return { level: 'error', message: 'список сайтов аккаунта не прочитался' };
  if (!r.hosts.data.site) return { level: 'error', message: 'нашего сайта нет в аккаунте Вебмастера этого токена' };
  const sections = [r.summary, r.queries, r.in_search, r.excluded];
  const failed = sections.filter((s) => !s || !s.ok).length;
  if (failed === sections.length) return { level: 'error', message: 'не прочитался ни один раздел' };
  if (failed > 0) return { level: 'warning', message: `не прочитались разделы: ${failed} из ${sections.length}` };
  return { level: 'ok', message: 'все разделы прочитаны' };
}
