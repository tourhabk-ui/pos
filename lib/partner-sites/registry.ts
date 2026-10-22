/**
 * Сайты партнёров, которые Ведар отдаёт со своего приложения.
 *
 * Слово владельца 22.10: fishingkam.ru «теперь под нашим управлением», доступ
 * к DNS есть (REG.RU). Сайт на Tilda и карточки на Ведаре расходились — цены,
 * сроки, состав; сверка 22.10 нашла это шестью вопросами к партнёру. Сайт,
 * который строится из той же базы, что карточки, разойтись с ними не может:
 * правка карточки — правка сайта.
 *
 * Здесь только связка «домен → партнёр» и то, чего в базе нет: заголовок и
 * описание для поисковика. Всё содержимое страницы — из `partners` и
 * `operator_tours` (lib/partner-sites/load.ts).
 *
 * Модуль без импортов: его читает и сервер (страница, корневой layout), и
 * браузер (lib/embed/widget-frame — глобальное Ведара молчит на чужом домене).
 * Тот же список стоит в next.config.js (CommonJS, отсюда не импортирует);
 * что они совпадают, держит tests/unit/partner-site-routing.test.ts.
 */

export interface PartnerSite {
  /** Домен без www и порта, в нижнем регистре. */
  host: string;
  /**
   * partners.id — чей это сайт. Не slug: slug партнёра меняется и у одного
   * партнёра их бывало несколько (у «Камчатской рыбалки» — fishingkam и
   * kamchatskaya-rybalka, 804). Реестр по slug 22.10 искал не тот, и
   * предпросмотр отвечал 404.
   */
  partnerId: string;
  /** Ключ в пути приложения: /partner-site/<key>. Только адрес, к базе не относится. */
  key: string;
  /** <title> на домене партнёра. Взят с прежнего сайта (снимок 22.10, проба 986). */
  title: string;
  /** meta description на домене партнёра. */
  description: string;
}

export const PARTNER_SITES: readonly PartnerSite[] = [
  {
    host: 'fishingkam.ru',
    // «Камчатская рыбалка»: id из живого каталога туров (863, 1312).
    partnerId: '0aaa4f05-b479-418b-9d54-2b909783dfd7',
    key: 'fishingkam',
    title: 'Рыбалка на Камчатке — туры на реку Камчатку с проживанием',
    description:
      'Рыболовные туры на реке Камчатке круглый год: летняя и зимняя рыбалка с проживанием на базе. ' +
      'Сроки, цены и состав туров, заявка Анатолию.',
  },
];

/** Путь, под которым страница сайта партнёра живёт в приложении. */
export const PARTNER_SITE_PATH = '/partner-site';

/** «WWW.FishingKam.ru:443» → «fishingkam.ru»; пусто — null. */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim().toLowerCase() ?? '';
  const host = first.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return host || null;
}

/** Сайт партнёра по домену запроса; домен Ведара и чужие — null. */
export function partnerSiteForHost(raw: string | null | undefined): PartnerSite | null {
  const host = normalizeHost(raw);
  if (!host) return null;
  return PARTNER_SITES.find((s) => s.host === host) ?? null;
}

/** Сайт партнёра по ключу пути /partner-site/<key>. */
export function partnerSiteByKey(key: string | null | undefined): PartnerSite | null {
  if (!key) return null;
  return PARTNER_SITES.find((s) => s.key === key) ?? null;
}

/** Путь страницы сайта партнёра внутри приложения (предпросмотр на vedarai.ru). */
export function isPartnerSitePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === PARTNER_SITE_PATH || pathname.startsWith(`${PARTNER_SITE_PATH}/`);
}

/** Адрес сайта партнёра на его домене. */
export function partnerSiteUrl(site: PartnerSite, path = '/'): string {
  return `https://${site.host}${path.startsWith('/') ? path : `/${path}`}`;
}
