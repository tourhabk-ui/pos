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
 */
import Link from 'next/link';
import { ArrowRight, Ticket } from 'lucide-react';
import { activityLabel } from '@/lib/tours/labels';
import { tourPriceFrom } from '@/lib/search/tour-query-match';

export interface ToursForQueryItem {
  id: number | string;
  title: string;
  operator_name: string | null;
  activity_type: string | null;
  base_price: number | string | null;
}

export type ToursForQueryState =
  | { status: 'ok'; tours: ToursForQueryItem[] }
  | { status: 'unavailable' };

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
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {state.tours.map(t => {
          const price = tourPriceFrom(t.base_price);
          const kind = activityLabel(t.activity_type);
          return (
            <li key={String(t.id)} className="min-w-0">
              <Link
                href={`/catalog/tours/${t.id}`}
                className="ds-card flex items-center gap-3 p-3 min-h-[64px] transition-all duration-200 hover:border-[var(--accent)]"
              >
                <span
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' }}
                  aria-hidden
                >
                  <Ticket size={18} className="text-[var(--accent)]" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-[var(--text-primary)] line-clamp-2">{t.title}</span>
                  <span className="block text-xs text-[var(--text-secondary)] truncate">
                    {[kind, t.operator_name].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {price && (
                  <span className="text-sm font-bold text-[var(--text-primary)] shrink-0 whitespace-nowrap">{price}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
