import Image from 'next/image';
import Link from 'next/link';
import { photoSrc } from '@/lib/images/variant';
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
 *
 * Снимок машины (1319, владелец 23.10 «бери фото автомобилей») — слева от
 * названия, вариантом 320 px; подпись автора — в title. Нет снимка — строка
 * без него, место под картинку не резервируется.
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
            {/* На телефоне строка в две полосы: снимок с названием и фактами, под
                ними цена и «Заказать» во всю ширину (dd — w-full); от sm — одна
                строка. Владелец 23.10 (снимок с телефона): четыре колонки в 360 px
                давили название на цену, факты шли по слову в строке, кнопка уходила
                за край экрана. */}
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
              {o.photo && (
                <div
                  className="relative w-20 h-14 shrink-0 rounded-lg overflow-hidden bg-[var(--bg-hover)]"
                  title={o.photo.credit ? `Фото: ${o.photo.credit}` : undefined}
                >
                  <Image src={photoSrc(o.photo.url, 320)} alt={`${o.title}: фото машины`} fill sizes="80px" className="object-cover" />
                </div>
              )}
              <dt className="min-w-0 flex-1 basis-40 text-sm text-[var(--text-primary)]">
                <span className="block font-semibold">{o.title}</span>
                <span className="block text-xs text-[var(--text-secondary)] mt-0.5">{offerFactsLine(o)}</span>
                <span className="block text-xs text-[var(--text-muted)] mt-0.5">{driverWord(o.driver)}</span>
              </dt>
              <dd className="flex w-full items-center justify-between gap-3 sm:w-auto sm:shrink-0 sm:justify-end">
                <span className="text-left sm:text-right">
                  <span className="block whitespace-nowrap text-base font-bold tabular-nums text-[var(--text-primary)]">{priceOnScreen(o)}</span>
                  {o.depositRub !== null && (
                    <span className="block text-xs text-[var(--text-muted)]">залог {formatRub(o.depositRub)}</span>
                  )}
                </span>
                {orderSlug && (
                  <Link
                    href={rentalOrderPath(orderSlug, o.title)}
                    prefetch={false}
                    className="ds-btn ds-btn-secondary px-3 shrink-0"
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
