'use client';

/**
 * Кнопка избранного — одна логика на все поверхности.
 *
 * Владелец 09.08: «избранное так и не работает». Каждая кнопка на витрине
 * писала свой обработчик, и каждый ошибался по-своему: чужие имена полей в
 * теле запроса, глотание ответа 400, редирект гостя на `/auth/signin` —
 * страницы, которой нет (вход живёт по `/auth/login`). Тут это написано один
 * раз, и поверхностям остаётся только нарисовать сердце.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { setWishlisted, isLocallyWishlisted } from '@/lib/wishlist/client';
import type { WishlistItemType } from '@/lib/wishlist/contract';

export interface UseWishlist {
  on: boolean;
  busy: boolean;
  /** Причина отказа словами — показывается рядом с кнопкой, а не в консоли. */
  error: string | null;
  toggle: (e?: { preventDefault?: () => void; stopPropagation?: () => void }) => Promise<void>;
}

export function useWishlist(type: WishlistItemType, id: string | number): UseWishlist {
  const router = useRouter();
  const itemId = String(id);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Локальное зеркало даёт мгновенное состояние без запроса на карточку в
  // списке; истина сервера видна в личном кабинете и на странице тура.
  useEffect(() => {
    setOn(isLocallyWishlisted(type, itemId));
  }, [type, itemId]);

  const toggle = useCallback<UseWishlist['toggle']>(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (busy) return;
    setBusy(true);
    setError(null);
    const next = !on;
    const res = await setWishlisted(type, itemId, next);
    if (res.unauthorized) {
      const from = typeof window !== 'undefined' ? window.location.pathname : '/catalog';
      router.push(`/auth/login?from=${encodeURIComponent(from)}`);
    } else if (res.ok) {
      setOn(next);
    } else {
      setError(res.error ?? 'Не удалось обновить избранное');
    }
    setBusy(false);
  }, [busy, on, type, itemId, router]);

  return { on, busy, error, toggle };
}
