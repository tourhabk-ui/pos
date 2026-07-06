'use client';

/**
 * MobileForYouTile — персональные рекомендации + баллы лояльности на главной.
 *
 * Рендерит СТРОКИ, а не карточки: RecommendationCard (components/tourist/)
 * сам является карточкой (bg-card + border) — вложить её в этот тайл
 * (тоже bg-card + border) было бы card-in-card, запрещено CLAUDE.md.
 *
 * Честность: у туриста без истории броней getRecommendations() и так
 * возвращает fallback с лейблом «Рекомендуем попробовать» — текст не
 * придумываем здесь, просто показываем то, что реально вернул API.
 * /api/tourist/recommendations гейтится requireRole(['tourist','admin']) —
 * для остальных ролей рекомендации не запрашиваем вовсе, не подделываем.
 */

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight, Mountain } from 'lucide-react';
import { useMobileAuth } from '@/contexts/MobileAuthContext';

interface RecommendedTourLite {
  id: string;
  title: string;
  price: number;
  images?: string[];
  strategyLabel: string;
}

interface LoyaltyLite {
  availablePoints: number;
  levelName: string;
}

export function MobileForYouTile() {
  const { status, role } = useMobileAuth();
  const [tours, setTours] = useState<RecommendedTourLite[] | null>(null);
  const [toursFailed, setToursFailed] = useState(false);
  const [loyalty, setLoyalty] = useState<LoyaltyLite | null>(null);

  useEffect(() => {
    if (status !== 'auth') return;
    let cancelled = false;
    const canSeeRecs = role === 'tourist' || role === 'admin';

    Promise.allSettled([
      canSeeRecs
        ? fetch('/api/tourist/recommendations?limit=3').then(res => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
        : Promise.reject(new Error('role not eligible')),
      fetch('/api/loyalty/stats').then(res => (res.ok ? res.json() : Promise.reject(new Error('unavailable')))),
    ]).then(([recRes, loyRes]) => {
      if (cancelled) return;

      if (recRes.status === 'fulfilled' && recRes.value?.success) {
        setTours(recRes.value.data ?? []);
      } else {
        setTours([]);
        if (canSeeRecs) setToursFailed(true);
      }

      if (loyRes.status === 'fulfilled' && loyRes.value?.success) {
        const d = loyRes.value.data;
        if (d) setLoyalty({ availablePoints: d.availablePoints, levelName: d.currentLevel?.name ?? '' });
      }
    });

    return () => { cancelled = true; };
  }, [status, role]);

  return (
    <div className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      {(status === 'loading' || (status === 'auth' && tours === null)) && (
        <>
          <span className="font-playfair text-lg font-bold text-[var(--text-primary)]">Для тебя</span>
          <div className="mt-3 space-y-2" aria-hidden>
            {[0, 1].map(i => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--bg-hover)]" />
            ))}
          </div>
        </>
      )}

      {status === 'guest' && (
        <>
          <span className="font-playfair text-lg font-bold text-[var(--text-primary)]">Для тебя</span>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Войдите — покажем туры, подобранные по вашей истории броней
          </p>
          <Link
            href={`/auth/login?from=${encodeURIComponent('/')}`}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm font-medium text-[var(--ocean)] transition-all duration-200 active:bg-[var(--bg-hover)]"
          >
            Войти и получить рекомендации
          </Link>
        </>
      )}

      {status === 'auth' && tours !== null && (
        <>
          <div className="flex items-center justify-between">
            <span className="font-playfair text-lg font-bold text-[var(--text-primary)]">Для тебя</span>
            {loyalty && (
              <span className="rounded-full bg-[var(--bg-hover)] px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                {loyalty.availablePoints} баллов
              </span>
            )}
          </div>

          {toursFailed && (
            <p className="mt-2 py-2 text-sm text-[var(--text-secondary)]">
              Рекомендации временно недоступны.{' '}
              <Link href="/marketplace" className="text-[var(--ocean)] underline">
                Маркетплейс
              </Link>
            </p>
          )}

          <div className="mt-2 space-y-1">
            {tours.map(t => (
              <Link
                key={t.id}
                href={`/marketplace/tours/${t.id}`}
                className="flex items-center gap-3 rounded-lg px-2 py-2 transition-all duration-200 active:bg-[var(--bg-hover)]"
              >
                <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--bg-hover)]">
                  {t.images?.[0] ? (
                    <Image src={t.images[0]} alt="" fill sizes="48px" className="object-cover" />
                  ) : (
                    <Mountain size={20} strokeWidth={1.5} className="absolute inset-0 m-auto text-[var(--text-muted)]" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{t.title}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{t.strategyLabel}</span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-[var(--accent)]">
                  {t.price.toLocaleString('ru-RU')} ₽
                </span>
                <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
