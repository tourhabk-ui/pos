'use client';

/**
 * «Другие компании к месту на вашу дату» на странице заявки (план «после
 * отказа», этап 4а, второй срез).
 *
 * После «мест нет» и отказа туроператора человек, открывший страницу заявки,
 * читал ответ и совет «выберите другой тур в каталоге». Те же компании, что
 * называет сообщение в чате, теперь стоят здесь — теми же словами
 * (lib/requests/other-offers-words) и в том же порядке (правило 1в, подпись —
 * последней строкой).
 *
 * Это не выбор Ведара и не обещание: «места есть» — о календаре тура; заявку
 * человек оставляет сам на форме тура, и только та компания получит его имя и
 * телефон. Цена — факт в строке, на место в списке она не влияет.
 *
 * Три исхода (§4.0): названы — список; не нашлось — блока нет; не прочиталось
 * — строка об этом, а не пустота, которая читалась бы «других нет».
 * Сторож — рендер: tests/unit/request-other-offers.test.tsx.
 */

import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';
import {
  OTHER_OFFERS_NOT_ANSWER_RU, otherOfferMoreToursWords, otherOfferSeatsWords, otherOffersMoreCompaniesWords,
  type OtherOfferSeats,
} from '@/lib/requests/other-offers-words';

export interface OtherOffersBlock {
  state: 'listed' | 'none' | 'failed';
  place: string | null;
  place_url: string | null;
  date: string;
  participants: number | null;
  offers: Array<{
    company: string;
    tour: string;
    tour_id: string;
    price: string | null;
    seats: OtherOfferSeats;
    url: string;
    more_tours: number;
  }>;
  more_companies: number;
}

export const OTHER_OFFERS_FAILED_RU =
  'Другие компании к этому месту на вашу дату сейчас не прочитались. Это не значит, что их нет: обновите страницу позже или посмотрите туры в каталоге.';

function dateRu(value: string): string {
  const t = new Date(`${value}T00:00:00`);
  return Number.isNaN(t.getTime()) ? value : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function capitalized(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Ссылка — только на этот сайт. Сервер отдаёт полный адрес формы, но в href
 * идёт лишь его путь: какой бы хост ни стоял в данных, кнопка «Оставить
 * заявку» на чужой сайт не уведёт.
 *
 * Адрес обязан разбираться как абсолютный http(s): относительный здесь не
 * принимается вовсе. Проверка «начинается с / и не с //» пропускала `/\host`
 * и `/<таб>/host` — браузер читает обратный слэш как прямой, а таб выбрасывает,
 * и такая ссылка вела на чужой хост (ревью безопасности 12.11). Путь после
 * разбора обязан начинаться с `/` и буквы или цифры: `//host` из
 * `https://сайт//host/…` тоже отсекается.
 */
export function sitePath(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return /^\/[A-Za-z0-9]/.test(path) ? path : null;
}

export function RequestOtherOffers({ block }: { block: OtherOffersBlock | null | undefined }) {
  if (!block || block.state === 'none') return null;
  if (block.state === 'failed') {
    return (
      <p className="text-sm text-[var(--text-secondary)] pt-3 border-t border-[var(--border)]" role="status">
        {OTHER_OFFERS_FAILED_RU}
      </p>
    );
  }
  if (block.offers.length === 0) return null;
  const placeHref = sitePath(block.place_url);
  return (
    <section aria-labelledby="other-offers-title" className="space-y-3 pt-4 border-t border-[var(--border)]">
      <h2 id="other-offers-title" className="text-lg font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
        {block.place ? `К месту «${block.place}» на ${dateRu(block.date)} — другие компании` : `Другие компании на ${dateRu(block.date)}`}
      </h2>
      <ol className="divide-y divide-[var(--border)]">
        {block.offers.map((o, i) => {
          const more = otherOfferMoreToursWords(o.more_tours);
          const href = sitePath(o.url);
          return (
            <li key={o.tour_id} className="py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{i + 1}. {o.company}</p>
                <p className="text-sm text-[var(--text-secondary)]">Тур «{o.tour}» · {o.price ?? 'цена не указана'}</p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {capitalized(otherOfferSeatsWords(o.seats, block.participants))}{more ? `; ${more}` : ''}.
                </p>
              </div>
              {href && (
                <a href={href} className="ds-btn ds-btn-secondary shrink-0" aria-label={`Оставить заявку: ${o.company}, тур «${o.tour}»`}>
                  Оставить заявку
                </a>
              )}
            </li>
          );
        })}
      </ol>
      {block.more_companies > 0 && placeHref && (
        <p className="text-sm text-[var(--text-secondary)]">
          {otherOffersMoreCompaniesWords(block.more_companies)} —{' '}
          <a href={placeHref} className="text-[var(--ocean)] hover:underline">на странице места</a>.
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)]">{OTHER_OFFERS_NOT_ANSWER_RU}</p>
      <p className="text-xs text-[var(--text-muted)]">{OFFER_ORDER_NOTE_ON_DATE_RU}</p>
    </section>
  );
}
