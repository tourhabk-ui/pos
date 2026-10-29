/**
 * Блок «Туры по запросу» на /routes (аудит П7, решение владельца 24.09 №9).
 *
 * Поиск героя главной на обоих деревьях ведёт на /routes?q=… — выдачу мест и
 * маршрутов. Туров там не было вовсе: «рыбалка» при семи рыболовных турах в
 * продаже отвечала «Ничего не найдено». Владелец оставил поиск на /routes
 * (поиск мест сохраняется), а туры по тому же запросу показываются здесь,
 * над выдачей мест, через движок ПОИСК (`lib/search/tour-query-match`).
 *
 * Три исхода, не два (§4.0):
 *   - `ok` с турами   — список, цена «от N ₽» только из настоящей цены;
 *   - `ok` без туров  — одна строка «туров не нашлось» и ссылка на каталог;
 *   - `unavailable`   — «туры сейчас не ищутся»: отказ БД не выдаётся за
 *                       «туров нет».
 *
 * Серверный компонент без состояния: данные приходят из RSC-страницы.
 * Значок у строки — тип активности (lib/tours/activity-icons), решение
 * владельца 12.10: джип-тур узнаётся машиной, а не общим билетом.
 */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { activityLabel } from '@/lib/tours/labels';
import { activityIcon } from '@/lib/tours/activity-icons';
import { tourPriceFrom } from '@/lib/search/tour-query-match';
import { tourPath } from '@/lib/tours/tour-url';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { plural } from '@/lib/home/data-freshness';

export interface ToursForQueryItem {
  id: number | string;
  slug?: string | null;
  title: string;
  operator_name: string | null;
  operator_slug?: string | null;
  operator_public?: boolean | null;
  activity_type: string | null;
  base_price: number | string | null;
}

export type ToursForQueryState =
  /** total — сколько совпало всего; null — точного числа нет; нет поля — не считалось. */
  | { status: 'ok'; tours: ToursForQueryItem[]; total?: number | null }
  | { status: 'unavailable' };

/**
 * Как выстроен блок (ревью 29.10): правило 1в работает внутри двух групп,
 * поэтому группы названы, а подпись кончается словами §0.
 */
export const TOURS_FOR_QUERY_ORDER_NOTE =
  'Сначала туры, совпавшие названием или описанием, затем — видом занятия; внутри каждой группы — сначала со свободными местами по ближайшему выезду, остальные раз в сутки по жребию. Место в списке не продаётся.';

export function ToursForQuery({ q, state }: { q: string; state: ToursForQueryState }) {
  const catalogHref = `/catalog?search=${encodeURIComponent(q)}`;

  if (state.status === 'unavailable') {
    return (
      <section aria-label="Туры по запросу" data-tours-for-query="unavailable" className="mb-6 ds-card p-4">
        <p className="text-sm text-[var(--text-primary)]">
          Туры по запросу сейчас не ищутся — это сбой у нас, а не пустой каталог.
        </p>
        <Link href="/catalog" className="mt-2 inline-flex items-center min-h-[44px] gap-1 text-sm font-semibold text-[var(--accent)]">
          Открыть каталог туров <ArrowRight size={14} aria-hidden />
        </Link>
      </section>
    );
  }

  if (state.tours.length === 0) {
    return (
      <p data-tours-for-query="empty" className="mb-5 text-sm text-[var(--text-secondary)]">
        Туров по «{q}» не нашлось.{' '}
        <Link href="/catalog" className="inline-flex items-center min-h-[44px] font-semibold text-[var(--accent)]">Все туры в продаже</Link>
      </p>
    );
  }

  return (
    <section aria-label="Туры по запросу" data-tours-for-query="ok" className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="ds-h2">Туры по запросу</h2>
        <Link href={catalogHref} className="text-sm font-semibold text-[var(--accent)] inline-flex items-center min-h-[44px] gap-1 shrink-0">
          В каталоге <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
      {(() => {
        const shown = state.tours.length;
        const total = state.total;
        const count = typeof total === 'number' && total > shown
          ? `Показано ${shown} из ${total} ${plural(total, 'тура', 'туров', 'туров')} — остальные в каталоге.`
          : total === null
            ? `Показано ${shown} — сколько совпало всего, здесь не посчитано; все — в каталоге.`
            : null;
        if (!count && shown < 2) return null;
        return (
          <div className="mb-3 space-y-1 text-xs text-[var(--text-secondary)]" data-tours-for-query-note>
            {count && <p>{count}</p>}
            {shown > 1 && <p>{TOURS_FOR_QUERY_ORDER_NOTE}</p>}
          </div>
        );
      })()}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {state.tours.map(t => {
          const price = tourPriceFrom(t.base_price);
          const kind = activityLabel(t.activity_type);
          // Значок — по типу активности (владелец 12.10: «в турах, наверное,
          // иконку активностей — в данном случае это джип-тур»), не билет.
          const Icon = activityIcon(t.activity_type);
          return (
            <li key={String(t.id)} className="min-w-0">
              {/* Ссылка на тур — слоем под содержимым, имя оператора — своей
                  ссылкой поверх (владелец 13.10): <a> в <a> недопустим. */}
              <div className="ds-card relative flex items-center gap-3 p-3 min-h-[64px] transition-all duration-200 hover:border-[var(--accent)]">
                <Link href={tourPath(t)} className="absolute inset-0 z-[1] rounded-lg" aria-label={t.title} />
                <span
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' }}
                  aria-hidden
                >
                  <Icon size={18} className="text-[var(--accent)]" />
                </span>
                <span className="flex-1 min-w-0 relative z-[2] pointer-events-none">
                  <span className="block text-sm font-semibold text-[var(--text-primary)] line-clamp-2">{t.title}</span>
                  <span className="block text-xs text-[var(--text-secondary)] truncate">
                    {kind}
                    {kind && t.operator_name ? ' · ' : ''}
                    {t.operator_name && (
                      <OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} className="pointer-events-auto" />
                    )}
                  </span>
                </span>
                {price && (
                  <span className="text-sm font-bold text-[var(--text-primary)] shrink-0 whitespace-nowrap relative z-[2] pointer-events-none">{price}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
