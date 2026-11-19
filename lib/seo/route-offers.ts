/**
 * Цена маршрута в разметке Schema.org — из туров, которые карточка маршрута
 * показывает в блоке «Туры по маршруту» (loadRouteDetail, §10 п.10).
 *
 * До 17.11 разметка брала `payload.price_from` записи маршрута: числа нет на
 * странице, и откуда оно, не записано (данные скрейпа). Поисковик показал бы
 * в выдаче «от N ₽», которого человек на карточке не увидит, — так нельзя ни
 * по правилам разметки, ни по §24: цена только с источником.
 *
 * Теперь `AggregateOffer`: самая низкая и самая высокая цена туров по
 * маршруту, их число и каждый тур отдельным `Offer` с продавцом — компанией
 * тура. Ведар маршрут не продаёт (§0), поэтому продавца у сводки нет.
 * В сводку идут только цены «за человека»: цену за группу и за день со своей
 * ценой с человека не сравнить, и «от» по ним было бы неправдой. Нет ни
 * одного тура с ценой за человека — цены в разметке нет.
 */
import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';
import { tourPath } from '@/lib/tours/tour-url';
import { offerShownPrice, ROUTE_PRICE_UNIT } from '@/lib/routes/route-tour-price';

export interface RouteOfferInput {
  tourId: number;
  /** Адрес тура: по номеру карточка переадресует на slug, в разметку — сразу он. */
  tourSlug?: string | null;
  /** Цена тура — та, что на его карточке (§11); зачёркнутая старая сюда не идёт. */
  priceBase: number | null;
  priceUnit: string | null;
  operator: { name: string | null } | null;
}


export function routeAggregateOffer(
  offers: readonly RouteOfferInput[],
  siteUrl: string,
): Record<string, unknown> | null {
  const priced = offers.flatMap((o) => {
    const price = o.priceUnit === ROUTE_PRICE_UNIT ? offerShownPrice(o) : null;
    return price === null ? [] : [{ o, price }];
  });
  if (priced.length === 0) return null;
  const prices = priced.map((x) => x.price);
  return {
    '@type': 'AggregateOffer',
    priceCurrency: 'RUB',
    lowPrice: Math.min(...prices),
    highPrice: Math.max(...prices),
    offerCount: priced.length,
    offers: priced.map(({ o, price }) => ({
      '@type': 'Offer',
      price,
      priceCurrency: 'RUB',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price,
        priceCurrency: 'RUB',
        unitText: PRICE_UNIT_LABELS.per_person,
      },
      url: `${siteUrl}${tourPath({ id: o.tourId, slug: o.tourSlug ?? null })}`,
      ...(o.operator?.name ? { seller: { '@type': 'Organization', name: o.operator.name } } : {}),
    })),
  };
}
