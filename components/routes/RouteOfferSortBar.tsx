'use client';

/**
 * Выбор порядка туров на карточке маршрута и подпись правила (правило 1в,
 * слово владельца 29.10). Правило называется словами на самой странице
 * (CLAUDE.md §0) и кончается «Место в списке не продаётся.»; под ним — что
 * цену включает сам турист. Отдельным компонентом — чтобы проверять рендером.
 */
import { Calendar, ListOrdered, TrendingUp, Users } from 'lucide-react';
import { OFFER_ORDER_NOTE, SORT_CHOICE_NOTE_RU } from '@/lib/tours/offer-order';
import { ROUTE_OFFER_SORTS, type RouteOfferSort } from '@/lib/routes/route-offer-sort';

const LABEL: Record<RouteOfferSort, string> = {
  order: 'Сначала со свободными местами',
  price: 'Цена',
  date: 'Дата',
  slots: 'Места',
};

const ICON = { order: ListOrdered, price: TrendingUp, date: Calendar, slots: Users } as const;

export function RouteOfferSortBar({ sortBy, onChange }: { sortBy: RouteOfferSort; onChange: (s: RouteOfferSort) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Порядок туров">
        {ROUTE_OFFER_SORTS.map(option => {
          const Icon = ICON[option];
          const on = sortBy === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(option)}
              className={`flex-shrink-0 min-h-[44px] px-3 text-xs font-semibold rounded-lg transition-colors inline-flex items-center gap-1 ${
                on
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--border)]'
              }`}
            >
              <Icon className="w-3 h-3" aria-hidden />
              {LABEL[option]}
            </button>
          );
        })}
      </div>
      <div className="space-y-1 text-xs leading-relaxed text-[var(--text-secondary)]">
        <p>{OFFER_ORDER_NOTE.ru}</p>
        <p>{SORT_CHOICE_NOTE_RU}</p>
      </div>
    </div>
  );
}
