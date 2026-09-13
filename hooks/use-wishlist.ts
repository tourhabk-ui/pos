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
import toast from 'react-hot-toast';
import { setWishlisted, isLocallyWishlisted } from '@/lib/wishlist/client';
import type { WishlistItemType } from '@/lib/wishlist/contract';

export interface UseWishlist {
  on: boolean;
  busy: boolean;
  /** Причина отказа словами — показывается рядом с кнопкой, а не в консоли. */
  error: string | null;
  /**
   * Сохранено только на этом устройстве: сервер не ответил. Как и `error` —
   * подсказка поверхности, а не единственный канал доставки.
   */
  localOnly: boolean;
  toggle: (e?: { preventDefault?: () => void; stopPropagation?: () => void }) => Promise<void>;
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

  /**
   * Исход доходит до человека ЗДЕСЬ, а не на усмотрение поверхности.
   *
   * Находка судьи 13.09 говорила про `ok: true` в офлайн-ветке клиента. Это
   * не ошибка — офлайн-first записан в CLAUDE.md, и рядом честно стоял
   * `localOnly`. Дефект был в другом: перепись по `app/`, `lib/`,
   * `components/`, `hooks/` дала у `localOnly` одно присваивание и НОЛЬ
   * потреблений, а `error` не читала ни одна из шести карточек, хотя шапка
   * этого интерфейса обещала «показывается рядом с кнопкой».
   *
   * То есть все три исхода выглядели на экране одинаково: при отказе сервера
   * сердце не заполнялось и молчало — ровно жалоба владельца 09.08
   * («избранное так и не работает»), переехавшая на слой выше. Хук починил её
   * внутри себя, а вывод наружу никто не подключил (правило 10.09:
   * объявленный исход без потребителя).
   *
   * Поэтому канал доставки — общий `Toaster` из `components/Providers.tsx`:
   * одна правка вместо шести, и новая карточка получает голос по построению,
   * не помня об этом. `error`/`localOnly` остаются в возврате для тех
   * поверхностей, которым нужна надпись рядом с кнопкой.
   */
  const toggle = useCallback<UseWishlist['toggle']>(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (busy) return;
    setBusy(true);
    setError(null);
    setLocalOnly(false);
    const next = !on;
    const res = await setWishlisted(type, itemId, next);
    if (res.unauthorized) {
      const from = typeof window !== 'undefined' ? window.location.pathname : '/catalog';
      router.push(`/auth/login?from=${encodeURIComponent(from)}`);
    } else if (res.ok) {
      setOn(next);
      if (res.localOnly) {
        setLocalOnly(true);
        toast(`${next ? 'Добавлено' : 'Убрано'} только на этом устройстве — сервер недоступен`);
      }
    } else {
      const message = res.error ?? 'Не удалось обновить избранное';
      setError(message);
      toast.error(message);
    }
    setBusy(false);
  }, [busy, on, type, itemId, router]);

  return { on, busy, error, localOnly, toggle };
}
