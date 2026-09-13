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
import { setWishlisted, isLocallyWishlisted, flushPendingWishlist } from '@/lib/wishlist/client';
import type { WishlistItemType } from '@/lib/wishlist/contract';

export interface UseWishlist {
  on: boolean;
  busy: boolean;
  /** Причина отказа словами — показывается рядом с кнопкой, а не в консоли. */
  error: string | null;
  /**
   * Отметка сохранена только на этом устройстве: сети не было, сервер её ещё
   * не подтвердил. Третье состояние рядом с «получилось» и «не получилось»
   * (§4.0): закрашенное сердце при нём значит не то же самое, что обычно, и
   * человек имеет право это знать. Досылка уйдёт сама, когда связь вернётся.
   */
  localOnly: boolean;
  toggle: (e?: { preventDefault?: () => void; stopPropagation?: () => void }) => Promise<void>;
}

/**
 * Подсказка про неподтверждённую отметку. ОДНА на платформу: шесть
 * поверхностей рисуют свою кнопку сами, и шесть формулировок одного
 * состояния разъехались бы при первой же правке (тот же урок, что у линий
 * карты в §12).
 */
export const WISHLIST_LOCAL_ONLY_HINT = 'Сохранено на этом устройстве — отправим, когда вернётся связь';

/** Подпись кнопки. Закрашенное сердце без сети значит НЕ то же самое. */
export function wishlistLabel(fav: Pick<UseWishlist, 'on' | 'localOnly'>): string {
  if (fav.localOnly) return 'В избранном — сохранено на этом устройстве, ждёт связи';
  return fav.on ? 'В избранном' : 'В избранное';
}

export function useWishlist(type: WishlistItemType, id: string | number): UseWishlist {
  const router = useRouter();
  const itemId = String(id);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);

  // Локальное зеркало даёт мгновенное состояние без запроса на карточку в
  // списке; истина сервера видна в личном кабинете и на странице тура.
  useEffect(() => {
    setOn(isLocallyWishlisted(type, itemId));
  }, [type, itemId]);

  // Досылка неподтверждённых отметок (13.09). До этой правки отметка,
  // поставленная без сети, не доезжала до аккаунта никогда — досылки не
  // существовало, хотя шапка клиента её обещала.
  //
  // Два повода: возвращение связи и монтирование кнопки. Второй нужен потому,
  // что событие `online` могло пройти, когда вкладка была закрыта, — тогда
  // единственный шанс догнать долг это следующее открытие страницы.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => {
      void flushPendingWishlist().then(({ left }) => {
        if (left === 0) setLocalOnly(false);
      });
    };
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);

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
      // Исход «сохранено только здесь» не приравнивается к «сохранено»:
      // именно этим сетевой сбой и маскировался под успех.
      setLocalOnly(res.localOnly === true);
    } else {
      setError(res.error ?? 'Не удалось обновить избранное');
    }
    setBusy(false);
  }, [busy, on, type, itemId, router]);

  return { on, busy, error, localOnly, toggle };
}
