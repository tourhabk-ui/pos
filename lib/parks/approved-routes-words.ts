/**
 * Слова и типы утверждённых маршрутов парков — без базы: модуль читают и
 * клиентская карточка маршрута, и сервер (lib/parks/approved-routes).
 * Подробности — в шапке lib/parks/approved-routes.ts.
 */
export const APPROVED_ROUTES_SOURCE = 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/';

/** Парки, чей список утверждённых маршрутов записан. */
export const APPROVED_ROUTES_PARKS = ['nalychevo', 'bystrinskiy', 'vilyuchinsky'] as const;

export const PARK_RULE_QUOTE = 'Передвижение по территории природных парков возможно только по утвержденным маршрутам.';

export type ApprovedSeason = 'summer' | 'winter' | 'all';

export interface ApprovedVariant {
  parkName: string;
  title: string;
  season: ApprovedSeason;
  /** «июнь-октябрь» словами парка; null — на странице не указан. */
  period: string | null;
  /** Способ передвижения словами парка; null — не указан. */
  movement: string | null;
  passportUrls: string[];
  trackUrl: string | null;
  sourceUrl: string;
  /** Когда прочитана страница парка, 'YYYY-MM-DD'. */
  readOn: string;
  /**
   * Статус по колонке «Статус» страницы парка при последнем чтении (1469);
   * null — не прочитан или старше трёх суток: «не проверено».
   */
  status: 'open' | 'closed' | null;
  /** Дата того чтения по Камчатке, 'YYYY-MM-DD'; null вместе со статусом. */
  statusReadOn: string | null;
}

export type ApprovedRouteCase =
  | { kind: 'linked'; variants: ApprovedVariant[] }
  | { kind: 'not_listed'; parkName: string; sourceUrl: string };

const SEASON_WORD: Record<ApprovedSeason, string> = { summer: 'летом', winter: 'зимой', all: 'круглый год' };

function readOnWords(d: string): string {
  return d.split('-').reverse().join('.');
}

/** Один вариант словами: «летом (июнь-октябрь): передвижение пешком». */
export function variantWords(v: ApprovedVariant): string {
  const when = v.period ? `${SEASON_WORD[v.season]} (${v.period})` : SEASON_WORD[v.season];
  return v.movement ? `${when}: ${v.movement.replace(/\.$/, '')}` : `${when}: способ передвижения на странице парка не указан`;
}

/** Статус варианта словами: «сейчас закрыт (по странице парка на 21.11)» или «статус не проверен». */
export function variantStatusWords(v: Pick<ApprovedVariant, 'status' | 'statusReadOn'>): string {
  if (!v.status || !v.statusReadOn) return 'статус на странице парка не проверен';
  return `сейчас ${v.status === 'open' ? 'открыт' : 'закрыт'} (по странице парка на ${readOnWords(v.statusReadOn)})`;
}

/**
 * Строки для карточки, Кузьмича и MCP — одни слова на всех. Статус «открыт /
 * закрыт» — по последнему чтению страницы парка (1469); устаревший или не
 * прочитанный называется «не проверен», а не «открыт».
 */
export function approvedRouteLines(c: ApprovedRouteCase | null): string[] {
  if (!c) return [];
  if (c.kind === 'not_listed') {
    return [
      `Среди утверждённых маршрутов парка (${c.parkName}) мы этот маршрут не нашли. Парк пишет: «${PARK_RULE_QUOTE}» Список — ${c.sourceUrl}`,
    ];
  }
  const byTitle = new Map<string, ApprovedVariant[]>();
  for (const v of c.variants) byTitle.set(`${v.parkName}|${v.title}`, [...(byTitle.get(`${v.parkName}|${v.title}`) ?? []), v]);
  const lines: string[] = [];
  for (const vs of byTitle.values()) {
    const v0 = vs[0]!;
    lines.push(`Утверждённый маршрут парка (${v0.parkName}): «${v0.title}» — ${vs.map((v) => `${variantWords(v)}, ${variantStatusWords(v)}`).join('; ')}.`);
  }
  const first = c.variants[0]!;
  lines.push(`Паспорт маршрута и GPS-трек — на сайте парка; источник: ${first.sourceUrl} (прочитано ${readOnWords(first.readOn)}).`);
  return lines;
}
