'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { Backpack, Star, X } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { GearBookingForm } from '@/components/gear/GearBookingForm';

/**
 * Публичная витрина аренды снаряжения. Бэкенд домена (gear_items,
 * GET /api/gear, форма аренды) существовал полностью, но не имел ни одной
 * страницы и ссылки — рабочий домен был недостижим для туриста.
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

const CONDITION_LABELS: Record<string, string> = {
  new: 'Новое', good: 'Хорошее', fair: 'Нормальное',
};

interface GearApiRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  brand: string | null;
  price_per_day: string | number;
  price_per_week: string | number | null;
  images: string[] | null;
  condition: string;
  available_quantity: number;
  rating: string | number | null;
  review_count: number | null;
  partner_name: string;
}

// Контракт GearBookingForm (components/gear/GearBookingForm.tsx)
interface GearItemForForm {
  id: string;
  name: string;
  category: string;
  description?: string;
  pricePerDay: number;
  pricePerWeek?: number;
  imageUrl?: string;
  availableQuantity: number;
  rating?: number;
  condition: 'new' | 'good' | 'fair';
}

function toFormItem(row: GearApiRow): GearItemForForm {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description ?? undefined,
    pricePerDay: Number(row.price_per_day),
    pricePerWeek: row.price_per_week != null ? Number(row.price_per_week) : undefined,
    imageUrl: row.images?.[0] ?? undefined,
    availableQuantity: row.available_quantity,
    rating: row.rating != null ? Number(row.rating) : undefined,
    condition: (['new', 'good', 'fair'].includes(row.condition) ? row.condition : 'good') as 'new' | 'good' | 'fair',
  };
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

export default function GearClient() {
  const [items, setItems] = useState<GearApiRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [bookingItem, setBookingItem] = useState<GearApiRow | null>(null);

  useEffect(() => {
    fetch('/api/gear?limit=60')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: GearApiRow[] } | null) => {
        if (d?.success && Array.isArray(d.data)) setItems(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

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
              Цены — за день аренды.
            </p>
          </div>

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
              {items.map(item => (
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
                    <p className="text-xs text-[var(--text-muted)]">{item.partner_name}</p>
                    <div className="mt-auto flex items-center justify-between pt-2">
                      <span className="text-sm font-bold text-[var(--accent)]">
                        {formatPrice(Number(item.price_per_day))}/день
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
