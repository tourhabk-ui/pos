import Link from 'next/link';
import { charterFootnote, charterOrderPath, formatRub, type CharterCarrier } from '@/lib/transfers/charter-format';

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
 */
export function CharterPriceList({ carrier, orderSlug }: {
  carrier: Pick<CharterCarrier, 'destinations' | 'extraDay'>;
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
                <span className="block text-sm font-semibold text-[var(--accent)]">{formatRub(d.priceRub)}</span>
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
        {carrier.extraDay && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 text-sm text-[var(--text-primary)]">Доплата за день</dt>
            {/* min-w-0: длинная подпись перевозчика переносится, а не уезжает за край карточки. */}
            <dd className="min-w-0 text-right">
              <span className="whitespace-nowrap text-sm font-semibold text-[var(--accent)]">+{formatRub(carrier.extraDay.priceRub)} в день</span>
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
