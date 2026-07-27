'use client';

import { useMemo, useState, useEffect } from 'react';
import Image from 'next/image';
import { Backpack, Star, X } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { GearBookingForm } from '@/components/gear/GearBookingForm';

/**
 * Публичная витрина аренды снаряжения.
 *
 * Контракт данных: /api/gear отдаёт то, что маппит findAvailableGear —
 * camelCase (pricePerDay, partnerName…). Прежний интерфейс здесь ждал
 * snake_case: на живых данных цены рендерились бы как «NaN ₽» — не
 * всплывало лишь потому, что позиций в проде ещё не было, а тест мокал
 * fetch «удобной» формой. Форма ответа теперь одна и под тестом.
 */

// category — свободный VARCHAR в gear_items; для незнакомых значений
// честно показываем сырое значение, не выдумываем лейбл
const CATEGORY_LABELS: Record<string, string> = {
  tent: 'Палатки', backpack: 'Рюкзаки', sleeping_bag: 'Спальники',
  sleeping: 'Спальники', trekking: 'Треккинг', clothing: 'Одежда',
  footwear: 'Обувь', cooking: 'Кухня', navigation: 'Навигация',
  safety: 'Безопасность', fishing: 'Рыбалка', winter: 'Зимнее',
  climbing: 'Альпинизм', electronics: 'Электроника', other: 'Разное',
};

// 'excellent' — дефолт схемы (migration 715): раньше его не было в словаре,
// и у позиций с дефолтным состоянием строка просто исчезала.
const CONDITION_LABELS: Record<string, string> = {
  new: 'Новое', excellent: 'Отличное', good: 'Хорошее', fair: 'Нормальное',
};

interface GearApiRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  brand: string | null;
  pricePerDay: number;
  pricePerWeek: number | null;
  pricePerMonth: number | null;
  depositAmount: number | null;
  insurancePerDay: number | null;
  images: string[] | null;
  condition: string;
  availableQuantity: number;
  rating: number | null;
  reviewCount: number | null;
  partnerName: string;
}

// Контракт GearBookingForm (components/gear/GearBookingForm.tsx)
interface GearItemForForm {
  id: string;
  name: string;
  category: string;
  description?: string;
  pricePerDay: number;
  pricePerWeek?: number;
  pricePerMonth?: number;
  insurancePerDay?: number;
  depositAmount?: number;
  imageUrl?: string;
  availableQuantity: number;
  rating?: number;
  condition: string;
}

function toFormItem(row: GearApiRow): GearItemForForm {
  return {
    id: row.id,
    name: row.name,
    category: CATEGORY_LABELS[row.category] ?? row.category,
    description: row.description ?? undefined,
    pricePerDay: Number(row.pricePerDay),
    pricePerWeek: row.pricePerWeek != null ? Number(row.pricePerWeek) : undefined,
    pricePerMonth: row.pricePerMonth != null ? Number(row.pricePerMonth) : undefined,
    insurancePerDay: row.insurancePerDay != null ? Number(row.insurancePerDay) : undefined,
    depositAmount: row.depositAmount != null ? Number(row.depositAmount) : undefined,
    imageUrl: row.images?.[0] ?? undefined,
    availableQuantity: row.availableQuantity,
    rating: row.rating != null ? Number(row.rating) : undefined,
    condition: row.condition,
  };
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

export default function GearClient() {
  const [items, setItems] = useState<GearApiRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [bookingItem, setBookingItem] = useState<GearApiRow | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/gear?limit=60')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: GearApiRow[] } | null) => {
        if (d?.success && Array.isArray(d.data)) setItems(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  // Фильтр категорий — из реальных данных, а не из словаря: показываем
  // только те чипы, за которыми есть хотя бы одна позиция.
  const categories = useMemo(() => {
    if (!items) return [];
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const visible = useMemo(
    () => (items ?? []).filter(it => !activeCategory || it.category === activeCategory),
    [items, activeCategory],
  );

  return (
    <>
      <Header />
      <div className="ds-page pt-20 pb-16">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-1">
              <Backpack className="w-6 h-6 text-[var(--accent)]" />
              <h1 className="ds-h1">Аренда снаряжения</h1>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              Палатки, рюкзаки, спальники и треккинговое снаряжение от партнёров платформы.
              Цены — за день аренды, при длинном сроке действуют недельные тарифы.
            </p>
          </div>

          {/* Категории */}
          {categories.length > 1 && (
            <div className="mb-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  activeCategory === null
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                Все
              </button>
              {categories.map(([cat, count]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(cat === activeCategory ? null : cat)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    activeCategory === cat
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {CATEGORY_LABELS[cat] ?? cat} · {count}
                </button>
              ))}
            </div>
          )}

          {/* Загрузка */}
          {items === null && !failed && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="ds-skeleton h-56 rounded-lg" />
              ))}
            </div>
          )}

          {/* Ошибка */}
          {failed && (
            <div className="ds-card p-8 text-center">
              <p className="text-sm text-[var(--text-secondary)]">
                Не удалось загрузить снаряжение. Обновите страницу или зайдите позже.
              </p>
            </div>
          )}

          {/* Пусто */}
          {items !== null && items.length === 0 && (
            <div className="ds-card p-8 text-center space-y-2">
              <Backpack className="w-10 h-10 mx-auto text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-secondary)]">
                Партнёры пока не выставили снаряжение в аренду. Загляните позже.
              </p>
            </div>
          )}

          {/* Список */}
          {items !== null && items.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visible.map(item => (
                <div key={item.id} className="ds-card rounded-lg overflow-hidden flex flex-col">
                  <div className="relative h-36 bg-[var(--bg-hover)]">
                    {item.images?.[0] ? (
                      <Image
                        src={item.images[0]}
                        alt={item.name}
                        fill
                        className="object-cover"
                        sizes="(max-width: 640px) 100vw, 33vw"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Backpack className="w-8 h-8 text-[var(--text-muted)]" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-[var(--text-primary)] leading-snug">{item.name}</p>
                      {item.rating != null && Number(item.rating) > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--warning)]">
                          <Star className="w-3 h-3 fill-[var(--warning)]" />
                          {Number(item.rating).toFixed(1)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">
                      {CATEGORY_LABELS[item.category] ?? item.category}
                      {item.brand ? ` · ${item.brand}` : ''}
                      {CONDITION_LABELS[item.condition] ? ` · ${CONDITION_LABELS[item.condition]}` : ''}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">{item.partnerName}</p>
                    <div className="mt-auto space-y-1.5 pt-2">
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm font-bold text-[var(--accent)]">
                          {formatPrice(Number(item.pricePerDay))}/день
                        </span>
                        {item.pricePerWeek != null && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {formatPrice(Number(item.pricePerWeek))}/нед
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--text-muted)]">
                          {item.depositAmount != null && item.depositAmount > 0
                            ? `Залог ${formatPrice(Number(item.depositAmount))}`
                            : ' '}
                        </span>
                        <button
                          type="button"
                          onClick={() => setBookingItem(item)}
                          className="ds-btn ds-btn-primary px-3 py-1.5 text-xs"
                        >
                          Арендовать
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Модалка аренды — существующая форма домена */}
      {bookingItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setBookingItem(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-[var(--bg-card)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <p className="font-semibold text-[var(--text-primary)]">Аренда: {bookingItem.name}</p>
              <button
                type="button"
                onClick={() => setBookingItem(null)}
                aria-label="Закрыть"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              <GearBookingForm
                gear={toFormItem(bookingItem)}
                onBookingComplete={() => setBookingItem(null)}
                onCancel={() => setBookingItem(null)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
