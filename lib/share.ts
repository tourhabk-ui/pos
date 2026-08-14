/**
 * lib/share.ts — «поделиться» одной реализацией.
 *
 * ── Что было ───────────────────────────────────────────────────────────────
 *
 * Четыре копии, четыре разных поведения:
 *
 *   карточка тура   — `if (navigator.share) { ... }` и НИЧЕГО в else. На
 *                     десктопном Firefox и в старом Chrome кнопка нажималась и
 *                     не делала ровно ничего;
 *   лист места      — фолбэк копирует ссылку молча: нажал, экран не дрогнул,
 *                     а ссылка уже в буфере — по виду тот же отказ;
 *   лояльность      — промис без `.catch`: отмена системного листа роняла
 *                     необработанный AbortError;
 *   шапка места     — единственная, где фолбэк и подтверждение сделаны верно.
 *
 * Это тот же класс, что и «кнопка поиска без обработчика» в шапке v8: элемент
 * выглядит рабочим и не даёт результата. Пятая копия рядом с четырьмя
 * расходящимися была бы не добавлением кнопки, а добавлением ещё одного
 * поведения.
 *
 * ── Что делает эта функция ─────────────────────────────────────────────────
 *
 * Возвращает ИСХОД, а не void. Исходов четыре, и они не схлопнуты:
 *
 *   shared      — системный лист принял, дальше дело системы;
 *   cancelled   — человек закрыл лист сам. Не ошибка: подтверждать нечего;
 *   copied      — листа нет (десктоп), ссылка легла в буфер. ТРЕБУЕТ отклика
 *                 на экране, иначе неотличимо от отказа;
 *   unavailable — не вышло ни то, ни другое. Тоже требует сказать вслух.
 *
 * Молчаливый `catch {}` здесь запрещён по построению: вызывающий обязан
 * разобрать исход, потому что тип его к этому принуждает.
 */

export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'unavailable';

export interface SharePayload {
  title: string;
  text?: string;
  url: string;
}

/** Человеческая подпись исхода. null — говорить нечего (успех или отмена). */
export function shareOutcomeMessage(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case 'copied':
      return 'Ссылка скопирована';
    case 'unavailable':
      return 'Не удалось поделиться — скопируйте адрес из строки браузера';
    case 'shared':
    case 'cancelled':
      return null;
  }
}

export async function shareLink(payload: SharePayload): Promise<ShareOutcome> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share(payload);
      return 'shared';
    } catch (err) {
      // Отмена — законный исход, а не сбой: человек передумал.
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Лист упал (бывает во встроенных вебвью) — не тупик, пробуем буфер.
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(payload.url);
      return 'copied';
    } catch {
      // Нет разрешения или небезопасный контекст (http). Скажем вслух ниже.
    }
  }

  return 'unavailable';
}
