import Link from 'next/link';
import { formatRub } from '@/lib/transfers/charter-format';
import { driverWord, offerFactsLine, priceOnScreen, rentalOrderPath, type RentalOffer } from '@/lib/rental/rental-format';

/**
 * Строки прайса проката — одна вёрстка на два экрана: карточку на витрине
 * /car-rental (RentalCompanyCard) и страницу прокатчика /car-rental/[slug].
 * Прайс, нарисованный двумя вёрстками, разошёлся бы в подписях.
 *
 * У каждой строки — только записанное: кузов, места (или «число мест не
 * записано»), коробка и привод, если названы, цена за сутки (со словом «от»,
 * если так написал прокатчик), водитель словами, залог — если записан.
 * Чего нет в строке базы, того нет и на экране (§4.0).
 *
 * С `orderSlug` у каждой строки — «Заказать»: форма заявки с этой машиной
 * (владелец 14.10: из прайса к заказу должно вести одно нажатие). `compact` —
 * карточка витрины: условия строки не раскрываются, они на странице.
 *
 * Цена строки — тем же голосом, что цена карточки тура: крупный жирный
 * tabular-nums цветом основного текста.
 */
export function RentalOfferList({ offers, orderSlug, compact = false }: {
  offers: ReadonlyArray<RentalOffer>;
  orderSlug?: string;
  compact?: boolean;
}) {
  return (
    <div>
      <dl>
        {offers.map((o) => (
          <div key={o.id} className="py-2.5 border-b border-[var(--border)]">
            <div className="flex items-start justify-between gap-3">
              <dt className="min-w-0 text-sm text-[var(--text-primary)]">
                <span className="block font-semibold">{o.title}</span>
                <span className="block text-xs text-[var(--text-secondary)] mt-0.5">{offerFactsLine(o)}</span>
                <span className="block text-xs text-[var(--text-muted)] mt-0.5">{driverWord(o.driver)}</span>
              </dt>
              <dd className="flex items-center gap-3 shrink-0">
                <span className="text-right">
                  <span className="block whitespace-nowrap text-base font-bold tabular-nums text-[var(--text-primary)]">{priceOnScreen(o)}</span>
                  {o.depositRub !== null && (
                    <span className="block text-xs text-[var(--text-muted)]">залог {formatRub(o.depositRub)}</span>
                  )}
                </span>
                {orderSlug && (
                  <Link
                    href={rentalOrderPath(orderSlug, o.title)}
                    prefetch={false}
                    className="ds-btn ds-btn-secondary px-3"
                    aria-label={`Заказать машину: ${o.title}`}
                  >
                    Заказать
                  </Link>
                )}
              </dd>
            </div>
            {!compact && o.priceIsFrom && (
              <p className="text-xs text-[var(--text-muted)] mt-1">Цена «от» — точную назовёт прокатчик.</p>
            )}
            {!compact && o.conditions && (
              <p className="text-xs text-[var(--text-secondary)] mt-1">{o.conditions}</p>
            )}
          </div>
        ))}
      </dl>
      <p className="text-xs text-[var(--text-muted)] mt-3">
        Цена — за сутки за машину целиком и не зависит от числа пассажиров. Залог и цена «от» — как записал прокатчик.
      </p>
    </div>
  );
}
