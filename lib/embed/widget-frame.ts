/**
 * Страницы-виджеты: то, что Ведар отдаёт ВНУТРЬ iframe на чужом сайте.
 *
 * `/widget/<partner>` (чат) и `/widget/lead-form/<slug>` (форма заявки)
 * рендерятся тем же корневым layout, что и сама платформа, и до 29.09 несли
 * в чужой сайт всё, что layout вешает на каждую страницу. Примерка на
 * fishingkam.ru показала цену:
 *
 * - StickyLeadButton «Подобрать тур» ложился поверх кнопки отправки в чате и
 *   поверх полей формы — отправить сообщение кликом было нельзя;
 * - наш баннер согласия на аналитику закрывал имя и телефон при первом
 *   открытии, а Метрика и хит `/api/analytics/hit` срабатывали на КАЖДЫЙ
 *   просмотр страницы партнёра: чужой визит считался визитом Ведара;
 * - каждый посетитель партнёра получал наш service worker (кэш ~1,8 МБ),
 *   хотя на Ведар он не заходил.
 *
 * Внутри виджета есть ровно одна задача — чат или форма. Всё остальное
 * глобальное обязано спрашивать `isForeignSurface` (ниже: виджет или сайт
 * партнёра) и молчать.
 */
import { isPartnerSitePath, partnerSiteForHost } from '@/lib/partner-sites/registry';

export const WIDGET_PATH_PREFIX = '/widget';

export function isWidgetPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === WIDGET_PATH_PREFIX || pathname.startsWith(`${WIDGET_PATH_PREFIX}/`);
}

/**
 * Чужая поверхность: виджет в iframe ИЛИ сайт партнёра, который Ведар отдаёт
 * на его домене (lib/partner-sites, fishingkam.ru с 22.10). Посетитель пришёл
 * к партнёру, а не к Ведару, и всё глобальное Ведара молчит так же, как в
 * виджете: ни Метрики и хита page_views (визит партнёра записался бы Ведару
 * как заход на главную — на домене партнёра путь «/»), ни баннера согласия,
 * ни service worker Ведара на чужом домене, ни приглашения поставить
 * приложение Ведара.
 *
 * На домене партнёра путь в браузере — «/» (страницу подставляет rewrite),
 * поэтому решает домен окна; на сервере его нет, и там решает только путь.
 */
export function isForeignSurface(
  pathname: string | null | undefined,
  hostname: string | null | undefined = typeof window !== 'undefined' ? window.location.hostname : null,
): boolean {
  return isWidgetPath(pathname) || isPartnerSitePath(pathname) || partnerSiteForHost(hostname) !== null;
}
