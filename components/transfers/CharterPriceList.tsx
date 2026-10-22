import Link from 'next/link';
import {
  charterFootnote, charterOrderPath, formatRub, rateLabel, rateOnScreen, type CharterCarrier,
} from '@/lib/transfers/charter-format';

/**
 * Строки прайса перевозчика «под заказ» — одна вёрстка на два экрана: карточку
 * в списке /transfers (CharterCard) и страницу перевозчика /transfers/[slug].
 * Прайс, нарисованный двумя вёрстками, разошёлся бы в подписях.
 *
 * Направление, связанное с местом справочника (миграция 1232), — ссылка на
 * карточку места; не связанное — словами перевозчика. Цена — «за машину»:
 * «за место» перевозчик не называл (§4.0).
 *
 * С `orderSlug` у каждой строки — «Заказать»: форма заявки с этим
 * направлением (владелец 14.10: «это сложно получается» — из прайса к заказу
 * не вело ничего). Доплата за день — не направление, заказать её нельзя.
 * Цена за час и за день (1292) — тоже не направление, но это и есть товар:
 * «Заказать» у неё открывает форму, где направление пишет заказчик.
 *
 * Цена строки — тем же голосом, что цена карточки тура: крупный жирный
 * tabular-nums цветом основного текста, а не мелкой акцентной подписью.
 * Размер скромнее турного (text-base, не text-lg): строк в прайсе много.
 */
export function CharterPriceList({ carrier, orderSlug }: {
  carrier: Pick<CharterCarrier, 'destinations' | 'extraDay' | 'rates'>;
  orderSlug?: string;
}) {
  const footnote = charterFootnote(carrier);
  return (
    <div>
      <dl>
        {carrier.destinations.map((d) => (
          <div
            key={`${d.from}/${d.to}`}
            className="flex items-center justify-between gap-3 py-2 border-b border-[var(--border)]"
          >
            <dt className="min-w-0 text-sm text-[var(--text-primary)]">
              {d.place ? (
                <Link href={d.place.href} className="text-[var(--ocean)] hover:underline">{d.to}</Link>
              ) : d.to}
              {d.place && d.place.name !== d.to && (
                <span className="block text-xs text-[var(--text-muted)]">место: {d.place.name}</span>
              )}
            </dt>
            <dd className="flex items-center gap-3 shrink-0">
              <span className="text-right">
                <span className="block text-base font-bold tabular-nums text-[var(--text-primary)]">{formatRub(d.priceRub)}</span>
                {d.note && <span className="block text-xs text-[var(--text-muted)]">{d.note}</span>}
              </span>
              {orderSlug && (
                <Link
                  href={charterOrderPath(orderSlug, d.to)}
                  prefetch={false}
                  className="ds-btn ds-btn-secondary px-3"
                  aria-label={`Заказать машину: ${d.to}`}
                >
                  Заказать
                </Link>
              )}
            </dd>
          </div>
        ))}
        {carrier.rates.map((r) => (
          <div
            key={r.unit}
            className="flex items-center justify-between gap-3 py-2 border-b border-[var(--border)]"
          >
            <dt className="min-w-0 text-sm text-[var(--text-primary)]">{rateLabel(r.unit)}</dt>
            <dd className="flex items-center gap-3 shrink-0">
              <span className="text-right">
                <span className="block whitespace-nowrap text-base font-bold tabular-nums text-[var(--text-primary)]">{rateOnScreen(r)}</span>
                {r.note && <span className="block text-xs text-[var(--text-muted)]">{r.note}</span>}
              </span>
              {orderSlug && (
                <Link
                  href={charterOrderPath(orderSlug)}
                  prefetch={false}
                  className="ds-btn ds-btn-secondary px-3"
                  aria-label={`Заказать машину: ${rateLabel(r.unit).toLowerCase()}`}
                >
                  Заказать
                </Link>
              )}
            </dd>
          </div>
        ))}
        {carrier.extraDay && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 text-sm text-[var(--text-primary)]">Доплата за день</dt>
            {/* min-w-0: длинная подпись перевозчика переносится, а не уезжает за край карточки. */}
            <dd className="min-w-0 text-right">
              <span className="whitespace-nowrap text-base font-bold tabular-nums text-[var(--text-primary)]">+{formatRub(carrier.extraDay.priceRub)} в день</span>
              {carrier.extraDay.note && (
                <span className="block text-xs text-[var(--text-muted)]">{carrier.extraDay.note}</span>
              )}
            </dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-[var(--text-muted)] mt-3">
        Цена — за машину целиком, не за место.{footnote ? ` ${footnote}` : ''}
      </p>
    </div>
  );
}
