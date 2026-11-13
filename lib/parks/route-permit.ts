/**
 * lib/parks/route-permit.ts
 *
 * Условия посещения охраняемой территории маршрута — для ответа Кузьмича и
 * MCP (#3302, срез 4, 12.11).
 *
 * Маршрут «Вилючинский водопад» лежит в природном парке с разрешительным
 * режимом. На его карточке блок «Разрешение на посещение парка» есть, а
 * агенту о маршруте говорилось одно слово — «Охраняемая территория: …». Что
 * туда нужно разрешение и где его берут, человек из чата не узнавал.
 *
 * Источников два, и оба уже есть — своих фактов здесь нет:
 *
 *   1. Правило lib/safety/park-permit (`permitRuleFor`) — то же, что читает
 *      карточка: Вачкажец (разрешения нет), территории Кроноцкого заповедника
 *      (заявка заповеднику), зона свободного посещения, парки, ушедшие в
 *      федеральное ведение.
 *   2. Справочник `parks` — что записано о территории: страница условий,
 *      почта, офис, Госуслуги41. Маршрут находит свою строку тем же правилом,
 *      что страница парка (routeInParkSql).
 *
 * Способы КГБУ («Зелёная кнопка», Госуслуги41, почта, офисы) называются,
 * только когда справочник ведёт территорию на страницу условий КГБУ — ту
 * самую, с которой способы сняты (PARK_PERMIT_SOURCE.url). По одному слову в
 * `park_name` ведомство не выводится: у Командорских островов — отдел охраны
 * в Никольском, и «Зелёная кнопка» к ним отношения не имеет.
 *
 * Исходов чтения справочника четыре, и «не прочиталось» не равно «не
 * записано» (§4.0): одна строка, нет строки, несколько строк, отказ базы.
 */
import { pool } from '@/lib/db-pool';
import { routeInParkSql } from '@/lib/parks/route-in-park';
import { CONDITIONS_NOT_RECORDED_RU, RECORDED_UNKNOWN_RU, ambiguousTerritoryRu } from '@/lib/parks/route-permit-card';
import {
  permitRuleFor,
  PARK_PERMIT_CHANNELS,
  PARK_PERMIT_SOURCE,
  FREE_VISIT_AREAS,
  GREEN_BUTTON,
  KRONOKI_REQUESTS,
  KRONOKI_ORDER_RU,
  FEDERAL_PERMIT_UNKNOWN_RU,
  type FederalizedPark,
  type KronokiTerritory,
  type NoPermitTerritory,
} from '@/lib/safety/park-permit';

/** Что справочник `parks` записал об условиях посещения территории. */
export interface ParkPermitRecord {
  slug: string;
  displayName: string;
  permitUrl: string | null;
  email: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  gosuslugiUrl: string | null;
  onlineUrl: string | null;
}

/** Исход поиска строки справочника по `park_name` маршрута. */
export type ParkLookup =
  | { state: 'one'; park: ParkPermitRecord }
  | { state: 'none' }
  | { state: 'many'; names: string[] }
  | { state: 'failed' };

/**
 * Какой случай у маршрута. `none` — территория у маршрута не записана и
 * правило её не называет: строк об условиях посещения нет вовсе.
 */
export type RoutePermitCase =
  | { kind: 'none' }
  | { kind: 'no_permit'; territory: NoPermitTerritory }
  | { kind: 'kronoki'; territory: KronokiTerritory }
  | { kind: 'free_visit' }
  | { kind: 'federal'; federal: FederalizedPark }
  | { kind: 'kgbu'; park: ParkPermitRecord }
  | { kind: 'recorded'; park: ParkPermitRecord }
  | { kind: 'unrecorded'; territory: string }
  | { kind: 'ambiguous'; territory: string; names: string[] }
  | { kind: 'unread'; territory: string };

export interface ParkPermitRow {
  slug: string;
  display_name: string;
  permit_url: string | null;
  permit_email: string | null;
  permit_office_address: string | null;
  permit_office_hours: string | null;
  permit_gosuslugi_url: string | null;
  permit_online_url: string | null;
}

/**
 * Строки справочника, к которым относится `park_name` маршрута ($1). Правило
 * связи то же, что у страницы парка и ссылки «страница парка» на карточке.
 * Берутся две: вторая нужна, только чтобы узнать неоднозначность.
 */
export const ROUTE_PARK_SQL = `
  SELECT slug, display_name, permit_url, permit_email, permit_office_address,
         permit_office_hours, permit_gosuslugi_url, permit_online_url
    FROM parks
   WHERE is_active
     AND ${routeInParkSql('$1::text', 'search_term', 'display_name')}
   ORDER BY slug
   LIMIT 2`;

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

function blank(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

function toRecord(r: ParkPermitRow): ParkPermitRecord {
  return {
    slug: r.slug,
    displayName: r.display_name,
    permitUrl: blank(r.permit_url),
    email: blank(r.permit_email),
    officeAddress: blank(r.permit_office_address),
    officeHours: blank(r.permit_office_hours),
    gosuslugiUrl: blank(r.permit_gosuslugi_url),
    onlineUrl: blank(r.permit_online_url),
  };
}

/**
 * Исход по найденным строкам справочника — одно правило на живой ответ и на
 * перепись (lib/parks/route-permit-census): нет строки, одна, несколько.
 */
export function lookupFromRows(rows: readonly ParkPermitRow[]): ParkLookup {
  const parks = rows.map(toRecord);
  if (parks.length === 0) return { state: 'none' };
  if (parks.length > 1) return { state: 'many', names: parks.map((p) => p.displayName) };
  return { state: 'one', park: parks[0] as ParkPermitRecord };
}

/** Строка справочника для `park_name` маршрута. Отказ базы — `failed`, в лог. */
export async function loadParkLookup(parkName: string, q: Queryable = pool): Promise<ParkLookup> {
  try {
    const { rows } = await q.query(ROUTE_PARK_SQL, [parkName]);
    return lookupFromRows(rows as ParkPermitRow[]);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[route-permit] справочник парков не прочитан:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return { state: 'failed' };
  }
}

/** Адрес без схемы, `www.` и хвостового слэша — для сравнения страниц. */
function pageKey(url: string | null): string | null {
  if (!url) return null;
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** Справочник ведёт территорию на страницу условий КГБУ — ту, с которой сняты способы. */
export function isKgbuPermitPage(url: string | null): boolean {
  const key = pageKey(url);
  return key !== null && key === pageKey(PARK_PERMIT_SOURCE.url);
}

function hasRecordedConditions(p: ParkPermitRecord): boolean {
  return Boolean(p.permitUrl || p.email || p.officeAddress || p.gosuslugiUrl || p.onlineUrl);
}

/**
 * Нужна ли строка справочника, чтобы назвать случай. Правило, которое
 * отвечает по названию (Вачкажец, Кроноцкий, свободная зона, федеральный
 * парк), справочника не ждёт; без `park_name` искать нечего.
 */
export function permitNeedsLookup(input: { title?: string | null; parkName?: string | null }): boolean {
  const rule = permitRuleFor(input);
  return rule.kind === 'park' && rule.federal === null && blank(input.parkName) !== null;
}

/**
 * Случай маршрута — чистое правило. `lookup` — исход чтения справочника;
 * `null` допустим, только когда `permitNeedsLookup` ответил «нет».
 */
export function routePermitCase(
  input: { title?: string | null; parkName?: string | null },
  lookup: ParkLookup | null,
): RoutePermitCase {
  const rule = permitRuleFor(input);
  if (rule.kind === 'no_permit') return { kind: 'no_permit', territory: rule.territory };
  if (rule.kind === 'kronoki') return { kind: 'kronoki', territory: rule.territory };
  if (rule.kind === 'free_visit') return { kind: 'free_visit' };
  if (rule.federal) return { kind: 'federal', federal: rule.federal };

  const territory = blank(input.parkName);
  if (territory === null) return { kind: 'none' };
  // Справочник не спросили или он не ответил — это не «условий нет».
  if (lookup === null || lookup.state === 'failed') return { kind: 'unread', territory };
  if (lookup.state === 'many') return { kind: 'ambiguous', territory, names: lookup.names };
  if (lookup.state === 'none') return { kind: 'unrecorded', territory };
  if (isKgbuPermitPage(lookup.park.permitUrl)) return { kind: 'kgbu', park: lookup.park };
  if (hasRecordedConditions(lookup.park)) return { kind: 'recorded', park: lookup.park };
  return { kind: 'unrecorded', territory };
}

/** Случай маршрута с чтением справочника, когда оно нужно. */
export async function routePermitCaseFor(
  route: { title?: string | null; park_name?: string | null },
  q: Queryable = pool,
): Promise<RoutePermitCase> {
  const input = { title: route.title ?? null, parkName: route.park_name ?? null };
  const lookup = permitNeedsLookup(input) ? await loadParkLookup(input.parkName as string, q) : null;
  return routePermitCase(input, lookup);
}

/**
 * Ключ случая: у двух маршрутов одной территории условия одни, и второй раз
 * в том же ответе они не печатаются.
 */
export function permitCaseKey(c: RoutePermitCase): string | null {
  switch (c.kind) {
    case 'none': return null;
    case 'no_permit': return `no_permit:${c.territory.match}`;
    case 'kronoki': return `kronoki:${c.territory.name}`;
    case 'free_visit': return 'free_visit';
    case 'federal': return `federal:${c.federal.match}`;
    case 'kgbu': return 'kgbu';
    case 'recorded': return `recorded:${c.park.slug}`;
    case 'unrecorded': return `unrecorded:${c.territory.toLowerCase()}`;
    case 'ambiguous': return `ambiguous:${c.territory.toLowerCase()}`;
    case 'unread': return `unread:${c.territory.toLowerCase()}`;
  }
}

/** Разрешение территории и регистрация в МЧС — разные обязанности. */
export const PERMIT_NOT_MCHS_RU =
  'Разрешение территории — не регистрация в МЧС: это разные обязанности, одно не заменяет другое.';

/**
 * Способы КГБУ строками. Ссылка стоит в конце строки или отделена пробелами:
 * знак препинания, прилипший к адресу, ломает его у читающего агента.
 */
export function kgbuChannelLines(): string[] {
  return PARK_PERMIT_CHANNELS.map((c) => {
    if (c.key === 'green_button') {
      const ios = GREEN_BUTTON.iosUrl ? `iPhone — ${GREEN_BUTTON.iosUrl}` : 'для iPhone — по названию в App Store';
      return `— «${c.title}»: ${c.detail}. Android — ${GREEN_BUTTON.androidUrl} · ${ios}`;
    }
    return c.href ? `— ${c.title}: ${c.detail}. Адрес: ${c.href}` : `— ${c.title}: ${c.detail}.`;
  });
}

/**
 * Зона свободного посещения — словами того же источника, что и способы. Правило
 * узнаёт её только по названию маршрута («Авачинский перевал»); маршрут к
 * соседней вершине назван иначе, и без этой строки агент прочёл бы одно
 * «посещение — по разрешению».
 */
export const FREE_VISIT_NOTE_RU =
  `Зона свободного посещения, где разрешение парка не требуется: ${FREE_VISIT_AREAS.join(', ')}.`;

/** Записанные в справочнике каналы — только заполненные поля. */
function recordedParts(p: ParkPermitRecord): string[] {
  const parts: string[] = [];
  if (p.permitUrl) parts.push(`страница условий — ${p.permitUrl}`);
  if (p.officeAddress) parts.push(`офис — ${p.officeAddress}${p.officeHours ? ` (${p.officeHours})` : ''}`);
  if (p.email) parts.push(`почта — ${p.email}`);
  if (p.gosuslugiUrl) parts.push(`Госуслуги41 — ${p.gosuslugiUrl}`);
  if (p.onlineUrl) parts.push(`онлайн — ${p.onlineUrl}`);
  return parts;
}

/**
 * Условия посещения словами — для модели. Пусто у `none`: о территории,
 * которой в данных нет, не говорится ничего.
 */
export function routePermitLines(c: RoutePermitCase): string[] {
  switch (c.kind) {
    case 'none':
      return [];
    case 'no_permit': {
      const t = c.territory;
      return [`Разрешение на посещение не требуется — ${t.name}: ${t.basis} (${t.authority}, ${t.asOf}). Источник: ${t.url}`];
    }
    case 'free_visit':
      return [
        'Разрешение парка не требуется — это зона свободного посещения '
        + `(${PARK_PERMIT_SOURCE.authority}, ${PARK_PERMIT_SOURCE.asOf}).`,
      ];
    case 'kronoki':
      return [
        `Условия посещения — ${c.territory.name}. ${KRONOKI_ORDER_RU} Страница заявок: ${KRONOKI_REQUESTS.url}`,
        PERMIT_NOT_MCHS_RU,
      ];
    case 'federal': {
      const f = c.federal;
      return [
        `Условия посещения: с ${f.since} ${f.name} — часть национального парка ${f.nationalPark} в ведении `
        + `Минприроды России (${f.source}). ${FEDERAL_PERMIT_UNKNOWN_RU} Источник: ${f.url}`,
        `Способы, которыми разрешение выдавал ${PARK_PERMIT_SOURCE.authority} (${PARK_PERMIT_SOURCE.asOf}):`,
        ...kgbuChannelLines(),
        PERMIT_NOT_MCHS_RU,
      ];
    }
    case 'kgbu':
      return [
        `Условия посещения — ${c.park.displayName}: посещение — по разрешению ${PARK_PERMIT_SOURCE.authority} `
        + `(${PARK_PERMIT_SOURCE.asOf}). Страница условий: ${PARK_PERMIT_SOURCE.url}`,
        'Способы получить разрешение:',
        ...kgbuChannelLines(),
        FREE_VISIT_NOTE_RU,
        PERMIT_NOT_MCHS_RU,
      ];
    case 'recorded':
      return [
        `Условия посещения — ${c.park.displayName}. ${RECORDED_UNKNOWN_RU} Что записано о территории:`,
        `— ${recordedParts(c.park).join(' · ')}`,
        PERMIT_NOT_MCHS_RU,
      ];
    case 'unrecorded':
      return [
        `В данных маршрута названа территория «${c.territory}». ${CONDITIONS_NOT_RECORDED_RU}`,
      ];
    case 'ambiguous':
      return [
        `В данных маршрута названа территория «${c.territory}». ${ambiguousTerritoryRu(c.names)}`,
      ];
    case 'unread':
      return [
        `Условия посещения территории «${c.territory}» прочитать не удалось — это не значит, что разрешение не нужно.`,
      ];
  }
}

/** Случаи маршрутов одного ответа — параллельно; порядок тот же, что у входа. */
export function routePermitCasesFor(
  routes: ReadonlyArray<{ title?: string | null; park_name?: string | null }>,
  q: Queryable = pool,
): Promise<RoutePermitCase[]> {
  return Promise.all(routes.map((r) => routePermitCaseFor(r, q)));
}

/**
 * Строки условий по маршрутам одного ответа. У второго маршрута той же
 * территории длинный блок (способы КГБУ — семь строк) не повторяется: стоит
 * отсылка к первому. Короткий случай в одну строку печатается как есть.
 */
export function permitLinesForRoutes(
  routes: ReadonlyArray<{ title: string }>,
  cases: readonly RoutePermitCase[],
): string[][] {
  const firstTitle = new Map<string, string>();
  return cases.map((c, i) => {
    const key = permitCaseKey(c);
    if (key === null) return [];
    const lines = routePermitLines(c);
    const earlier = firstTitle.get(key);
    if (earlier !== undefined && lines.length > 1) {
      return [`Условия посещения территории — те же, что у маршрута «${earlier}» выше.`];
    }
    if (earlier === undefined) firstTitle.set(key, routes[i]?.title ?? '');
    return lines;
  });
}
