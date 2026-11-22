/**
 * «Нужно ли разрешение на посещение» — справка из одного источника фактов
 * (#3566 п.5, 21.11). Google Search Console и замер выдачи 20.11: по этому
 * вопросу топ целиком у сайта парка, у Ведара страницы не было.
 *
 * Ни одного факта здесь нет своего: способы, сроки, адреса, переход парков в
 * федеральное ведение и порядок Кроноцкого заповедника читаются из
 * lib/safety/park-permit.ts — того же места, что говорит карточке маршрута,
 * Кузьмичу и MCP. Иначе справочная страница и карточка разошлись бы при
 * первой правке.
 */
import {
  FEDERAL_PERMIT_UNKNOWN_RU,
  FEDERALIZED_PARKS,
  FREE_VISIT_AREAS,
  GREEN_BUTTON,
  KRONOKI_ORDER_RU,
  KRONOKI_REQUESTS,
  KRONOKI_TERRITORIES,
  NO_PERMIT_TERRITORIES,
  PARK_PERMIT_CHANNELS,
  PARK_PERMIT_SOURCE,
  VOLCANOES_DECREE_DOC,
  PERMIT_NOT_MCHS_RU,
} from '@/lib/safety/park-permit';
import { recordDateIso } from '@/lib/seo/record-modified';
import { DEFAULT_OG_IMAGE } from '@/lib/seo/og-image';
import { PERMIT_GUIDE_PATH } from '@/lib/seo/permit-guide-path';

export { PERMIT_GUIDE_PATH };

/**
 * Реестр официальных паспортов маршрутов края — портал Минтуризма Камчатки.
 * PDF не копируем: ссылка ведёт туда, где паспорт обновляет его автор.
 */
export const ROUTE_PASSPORTS_REGISTRY = {
  title: 'реестр паспортов туристских маршрутов Камчатского края',
  url: 'https://visitkamchatka.ru/route-passports/',
} as const;

export interface PermitFaq { q: string; a: string }

/** Перечисление «А, Б и В». */
function joinRu(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

export function federalizedParksRu(): string {
  return joinRu(FEDERALIZED_PARKS.map((p) => p.name));
}

export function kronokiTerritoriesRu(): string {
  return joinRu(KRONOKI_TERRITORIES.map((t) => t.name));
}

/** Способы краевого парка одной строкой — для ответа в FAQ (на странице они списком). */
function channelsRu(): string {
  return PARK_PERMIT_CHANNELS.map((c) => (c.key === 'green_button' ? `приложение «${c.title}»` : c.title.toLowerCase()))
    .join('; ');
}

/** Вопросы и ответы страницы — тексты для людей и для FAQPage. */
export function permitFaq(): PermitFaq[] {
  const federal = FEDERALIZED_PARKS[0];
  return [
    {
      q: 'Нужно ли разрешение, чтобы пойти на маршрут в природном парке на Камчатке?',
      a: `Да: территория природных парков «Вулканы Камчатки» посещается по разрешению — так пишет ${PARK_PERMIT_SOURCE.authority} (${PARK_PERMIT_SOURCE.asOf}). `
        + `Исключение — зона свободного посещения: ${FREE_VISIT_AREAS.join(', ')}.`,
    },
    {
      q: 'Как получить разрешение парка?',
      a: `Способы, которые называет парк: ${channelsRu()}. Источник: ${PARK_PERMIT_SOURCE.url} (${PARK_PERMIT_SOURCE.asOf}).`,
    },
    ...(federal ? [{
      q: `Что изменилось для парков ${federalizedParksRu()}?`,
      a: `С ${federal.since} они — часть национального парка ${federal.nationalPark} (${VOLCANOES_DECREE_DOC.title}). ${FEDERAL_PERMIT_UNKNOWN_RU}`,
    }] : []),
    {
      q: 'Нужно ли разрешение в Долину гейзеров и на Курильское озеро?',
      a: `Да. ${kronokiTerritoriesRu()} — территории ${KRONOKI_REQUESTS.authority}. ${KRONOKI_ORDER_RU}`,
    },
    {
      q: 'Разрешение на посещение и регистрация в МЧС — одно и то же?',
      a: `Нет. ${PERMIT_NOT_MCHS_RU} Разрешение даёт право находиться на территории, регистрация сообщает спасателям о выходе группы.`,
    },
    {
      q: 'Где посмотреть официальный паспорт маршрута?',
      a: `В ${ROUTE_PASSPORTS_REGISTRY.title}: ${ROUTE_PASSPORTS_REGISTRY.url}. На карточке маршрута Ведара ссылка на паспорт стоит, если он записан.`,
    },
  ];
}

export {
  FEDERALIZED_PARKS, FEDERAL_PERMIT_UNKNOWN_RU, FREE_VISIT_AREAS, GREEN_BUTTON, KRONOKI_ORDER_RU, KRONOKI_REQUESTS,
  KRONOKI_TERRITORIES, NO_PERMIT_TERRITORIES, PARK_PERMIT_CHANNELS, PARK_PERMIT_SOURCE, VOLCANOES_DECREE_DOC, PERMIT_NOT_MCHS_RU,
};


/** Заголовок страницы без шаблона бренда; в metadata layout добавит «| Ведар». */
export const PERMIT_GUIDE_TITLE = 'Нужно ли разрешение на посещение мест Камчатки';
export const PERMIT_GUIDE_H1 = PERMIT_GUIDE_TITLE;
export const PERMIT_GUIDE_AUTHOR = 'Редакция Vedar';
/**
 * Дата ревизии текста справки: справочник собран в страницу 21.11.2026
 * (#3566 п.5, заголовок этого модуля). Не «сегодня»: факты меняются —
 * сдвигаем дату вместе с правкой.
 */
export const PERMIT_GUIDE_DATE = '2026-11-21';

export const PERMIT_GUIDE_DESCRIPTION =
  'Кто и как выдаёт разрешение в парки «Вулканы Камчатки», Долину гейзеров и на Курильское озеро — по официальным страницам. Разрешение — не регистрация в МЧС.';

export function permitArticleJsonLd(site: string): Record<string, unknown> {
  const url = `${site}${PERMIT_GUIDE_PATH}`;
  const published = recordDateIso(PERMIT_GUIDE_DATE);
  const org = { '@type': 'Organization', '@id': `${site}/#organization`, name: 'Ведар Камчатка', url: site };
  const faq = permitFaq();
  const article: Record<string, unknown> = {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: PERMIT_GUIDE_H1,
    description: PERMIT_GUIDE_DESCRIPTION,
    inLanguage: 'ru',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    image: `${site}${DEFAULT_OG_IMAGE}`,
    author: { '@type': 'Organization', name: PERMIT_GUIDE_AUTHOR, url: site },
    publisher: org,
    ...(published ? { datePublished: published, dateModified: published } : {}),
  };
  const graph: Record<string, unknown>[] = [article];
  if (faq.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function permitBreadcrumbJsonLd(site: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: site },
      { '@type': 'ListItem', position: 2, name: PERMIT_GUIDE_H1, item: `${site}${PERMIT_GUIDE_PATH}` },
    ],
  };
}
