import Link from 'next/link';
import { charterFootnote, formatRub, type CharterCarrier } from '@/lib/transfers/charter-format';

/**
 * Строки прайса перевозчика «под заказ» — одна вёрстка на два экрана: карточку
 * в списке /transfers (CharterCard) и страницу перевозчика /transfers/[slug].
 * Прайс, нарисованный двумя вёрстками, разошёлся бы в подписях.
 *
 * Направление, связанное с местом справочника (миграция 1232), — ссылка на
 * карточку места; не связанное — словами перевозчика. Цена — «за машину»:
 * «за место» перевозчик не называл (§4.0).
 */
export function CharterPriceList({ carrier }: { carrier: Pick<CharterCarrier, 'destinations' | 'extraDay'> }) {
  const footnote = charterFootnote(carrier);
  return (
    <div>
      <dl>
        {carrier.destinations.map((d) => (
          <div
            key={`${d.from}/${d.to}`}
            className="flex items-baseline justify-between gap-3 py-2 border-b border-[var(--border)]"
          >
            <dt className="text-sm text-[var(--text-primary)]">
              {d.place ? (
                <Link href={d.place.href} className="text-[var(--ocean)] hover:underline">{d.to}</Link>
              ) : d.to}
              {d.place && d.place.name !== d.to && (
                <span className="block text-xs text-[var(--text-muted)]">место: {d.place.name}</span>
              )}
            </dt>
            <dd className="text-right shrink-0">
              <span className="text-sm font-semibold text-[var(--accent)]">{formatRub(d.priceRub)}</span>
              {d.note && <span className="block text-xs text-[var(--text-muted)]">{d.note}</span>}
            </dd>
          </div>
        ))}
        {carrier.extraDay && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-sm text-[var(--text-primary)]">Доплата за день</dt>
            <dd className="text-right shrink-0">
              <span className="text-sm font-semibold text-[var(--accent)]">+{formatRub(carrier.extraDay.priceRub)} в день</span>
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
