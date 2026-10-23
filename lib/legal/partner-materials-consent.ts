/**
 * Согласие партнёра на использование материалов его сайта на Ведаре —
 * единый источник текста, версии и объёма (решение владельца 23.10: «нужна
 * форма согласия об использовании матерьялов сайтов партнеров на нашем
 * сайте»; запись — миграция 1321).
 *
 * Текст и версия меняются вместе и никогда задним числом — тот же договор,
 * что у согласия на ПД (lib/legal/pd-consent.ts): записывается не «галочка
 * стояла», а текст, под которым партнёр подписался.
 *
 * Объём — виды материалов × где их показывать, а не «вообще да»: 1263 и 1265
 * уже показали, что согласие на туры не покрывает карточки мест. Своя
 * страница партнёра входит всегда.
 *
 * Согласие не даёт места выше в общих списках (CLAUDE.md §0): порядок там
 * один для всех, платное поднятие — только реклама с маркировкой.
 */

export const PARTNER_MATERIALS_CONSENT_VERSION = '2026-10-23';

export const MATERIAL_KINDS = ['photos', 'video', 'logo', 'texts', 'prices'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_WORDS: Record<MaterialKind, string> = {
  photos: 'фотографии',
  video: 'видео',
  logo: 'логотип',
  texts: 'описания услуг и условия',
  prices: 'цены',
};

export const CONSENT_SURFACES = ['own_page', 'showcases', 'assistants', 'channel'] as const;
export type ConsentSurface = (typeof CONSENT_SURFACES)[number];

/** Где Ведар показывает материалы. own_page обязателен: без него согласие ни о чём. */
export const SURFACE_WORDS: Record<ConsentSurface, string> = {
  own_page: 'страница партнёра на Ведаре и карточки его предложений',
  showcases: 'общие витрины Ведара: главная, каталог, списки трансферов и проката, карточки мест',
  assistants: 'ответы помощника Кузьмича и ИИ-агентов, подключённых к Ведару',
  channel: 'публикации Ведара в Telegram и MAX',
};

export const REQUIRED_SURFACE: ConsentSurface = 'own_page';

/** Согласие на экране — без имени подписанта: его видит только администратор. */
export interface MaterialsConsentPublic {
  /** YYYY-MM-DD по Камчатке. */
  grantedOn: string;
  materials: MaterialKind[];
  surfaces: ConsentSurface[];
  sites: string[];
}

/** Адрес сайта без протокола и хвостового слэша: «лагунапрокат.рф». */
export function siteWords(site: string): string {
  return site.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

export interface MaterialsConsentScope {
  partnerName: string;
  sites: readonly string[];
  materials: readonly MaterialKind[];
  surfaces: readonly ConsentSurface[];
}

/**
 * Текст согласия под выбранный объём — его партнёр читает и под ним
 * подписывается. Абзацы — массивом: так их рисует страница и так их легко
 * сверить в сторожах.
 */
export function materialsConsentParagraphs(s: MaterialsConsentScope): string[] {
  const sites = s.sites.length > 0 ? `со своих сайтов и страниц (${s.sites.map(siteWords).join(', ')})` : 'со своих сайтов и страниц';
  const kinds = listWords(MATERIAL_KINDS.filter((k) => s.materials.includes(k)).map((k) => MATERIAL_WORDS[k]));
  const where = CONSENT_SURFACES.filter((x) => s.surfaces.includes(x)).map((x) => SURFACE_WORDS[x]);
  return [
    `«${s.partnerName}» разрешает Ведару (vedarai.ru) безвозмездно и на неисключительной основе использовать материалы ${sites}: ${kinds}, — чтобы рассказывать туристам о своих услугах.`,
    `Где Ведар может их показывать: ${where.join('; ')}.`,
    'Материалы остаются собственностью партнёра. Ведар показывает их с указанием источника, не передаёт и не продаёт третьим лицам и не меняет их смысл; снимки может уменьшать и кадрировать для показа.',
    'Согласие не даёт партнёру места выше других в общих списках Ведара: порядок там один для всех.',
    'Согласие действует, пока партнёр его не отзовёт. Отозвать можно сообщением менеджеру Ведара в MAX или Telegram, после отзыва Ведар снимает материалы с показа.',
  ];
}

/** Подтверждение полномочий — отдельной строкой рядом с галочкой. */
export function authorityStatement(partnerName: string): string {
  return `Подтверждаю, что вправе дать это согласие от имени «${partnerName}»: материалы принадлежат партнёру или он вправе ими распоряжаться, а люди, узнаваемые на снимках, согласны на их показ.`;
}

/** «2026-10-23» → «23.10.2026»; не разобралось — как есть. */
function dateWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/**
 * Строка на собственной странице партнёра: что взято с его сайта и что на это
 * есть его согласие. Только при записанном неотозванном согласии — без записи
 * строки нет вовсе (§4.0), и на общих витринах её нет никогда (§0: знак на
 * общей витрине был бы выделением, а не правдой о себе).
 */
export function materialsConsentLine(c: { grantedOn: string; materials: readonly string[]; sites: readonly string[] }): string {
  const kinds = MATERIAL_KINDS.filter((k) => c.materials.includes(k)).map((k) => MATERIAL_WORDS[k]);
  const what = listWords(kinds);
  const head = what ? what.charAt(0).toUpperCase() + what.slice(1) : 'Материалы';
  const from = c.sites.length > 0 ? `с сайта ${c.sites.map(siteWords).join(', ')}` : 'с сайта партнёра';
  return `${head} — ${from}, с согласия партнёра от ${dateWords(c.grantedOn)}.`;
}
