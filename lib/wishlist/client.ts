/**
 * Клиент избранного — единственная дверь к API для всех поверхностей.
 *
 * До 09.08 каждая кнопка ходила к серверу сама, и половина ходила с чужими
 * именами полей: сервер отвечал 400, а кнопка молчала. Теперь тело запроса
 * собирается здесь, и ошибка возвращается словами — молчащая кнопка хуже
 * ошибки, потому что о ней никто не узнает.
 *
 * Офлайн-first (CLAUDE.md): в поле связи может не быть, поэтому отметка
 * сохраняется локально и переживает отсутствие сети. Локальная копия — это
 * зеркало, а не второе хранилище: источник истины — сервер.
 */

import type { WishlistItemType } from './contract';

const LS_KEY = 'wishlist_local';

export interface WishlistResult {
  ok: boolean;
  /** Гость: поверхность сама решает, вести ли на вход. */
  unauthorized?: boolean;
  /** Причина словами — её показывают рядом с кнопкой. */
  error?: string;
  /** Сохранено только локально: сервер недоступен. */
  localOnly?: boolean;
}

function localKey(type: WishlistItemType, id: string): string {
  return `${type}:${id}`;
}

export function readLocal(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function isLocallyWishlisted(type: WishlistItemType, id: string): boolean {
  return readLocal().includes(localKey(type, id));
}

function writeLocal(type: WishlistItemType, id: string, on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  const key = localKey(type, id);
  const next = on
    ? Array.from(new Set([...readLocal(), key]))
    : readLocal().filter(k => k !== key);
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* квота или приватный режим */ }
}

/**
 * Добавить или убрать. `on` — желаемое состояние, а не переключатель: кнопка,
 * которая «переключает», разъезжается с сервером при первой же ошибке.
 */
export async function setWishlisted(
  type: WishlistItemType,
  id: string | number,
  on: boolean,
): Promise<WishlistResult> {
  const itemId = String(id);
  const body = JSON.stringify({ itemType: type, itemId });

  try {
    const res = await fetch('/api/tourist/wishlist', {
      method: on ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 401) return { ok: false, unauthorized: true };

    const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
    if (res.ok && data.success !== false) {
      writeLocal(type, itemId, on);
      return { ok: true };
    }
    return { ok: false, error: data.error ?? 'Не удалось обновить избранное' };
  } catch {
    // Нет сети — отметка живёт локально до возвращения связи.
    writeLocal(type, itemId, on);
    return { ok: true, localOnly: true };
  }
}

// fetchWishlistedIds убрана 22.08.2026 (перепись).
//
// Спрашивала у сервера, что уже в избранном, ради начального состояния
// кнопок в списке. Решение принято другое и записано в hooks/use-wishlist:
// на карточках показывается локальное зеркало — мгновенно и без запроса, а
// истина сервера видна в личном кабинете и на странице тура. Цена решения
// известна: на другом устройстве список покажет пусто.
