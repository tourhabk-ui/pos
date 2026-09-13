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
 *
 * ДОСЫЛКА ПОСЛЕ СВЯЗИ (13.09, находка Evo Judge «сетевой сбой маскируется
 * под успех»). Эта шапка обещала «отметка живёт локально ДО ВОЗВРАЩЕНИЯ
 * СВЯЗИ» — и досылки не существовало: `readLocal` читался только внутри
 * этого файла, ни одного вызова на `online` или при монтировании не было
 * нигде. То есть отметка, поставленная без сети, не доезжала до аккаунта
 * НИКОГДА: сердце закрашивалось, выглядело сохранённым, а на другом
 * устройстве его не было. Докстрока, обещающая путь, которого нет, —
 * дефект кода, а не документации.
 *
 * Поэтому здесь два разных списка, и разница между ними существенна:
 *   `wishlist_local`   — зеркало: что показывать закрашенным сразу, без
 *                        запроса. Пополняется и при успехе, и при офлайне;
 *   `wishlist_pending` — ДОЛГ: что сервер ещё не подтвердил. Пополняется
 *                        только при офлайне и вычищается по подтверждению.
 * Без второго списка досылать нечего: по зеркалу не отличить подтверждённую
 * отметку от неподтверждённой, и досылка гоняла бы к серверу всё подряд.
 */

import type { WishlistItemType } from './contract';

const LS_KEY = 'wishlist_local';
const PENDING_KEY = 'wishlist_pending';

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

/** Неподтверждённая сервером отметка: что досылать, когда связь вернётся. */
interface PendingMark {
  type: WishlistItemType;
  id: string;
  /** Желаемое состояние, не переключатель — как и у setWishlisted. */
  on: boolean;
}

function readPending(): PendingMark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is PendingMark =>
      typeof v === 'object' && v !== null
      && typeof (v as PendingMark).type === 'string'
      && typeof (v as PendingMark).id === 'string'
      && typeof (v as PendingMark).on === 'boolean');
  } catch {
    return [];
  }
}

function writePending(list: PendingMark[]): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* квота или приватный режим */ }
}

/**
 * Записать долг. По одной записи на предмет, а не по одной на нажатие:
 * человек может поставить и снять отметку пять раз без сети, и досылать это
 * пятью запросами незачем — серверу важно последнее состояние.
 */
function rememberPending(type: WishlistItemType, id: string, on: boolean): void {
  const rest = readPending().filter(p => !(p.type === type && p.id === id));
  writePending([...rest, { type, id, on }]);
}

function forgetPending(type: WishlistItemType, id: string): void {
  writePending(readPending().filter(p => !(p.type === type && p.id === id)));
}

/**
 * Досылка долгов. Зовётся при возвращении связи и при монтировании кнопки.
 *
 * Один проход, без повторов внутри: не дошло — долг остаётся, следующий
 * `online` попробует снова. Цикл повторов здесь превратил бы потерю связи в
 * шторм запросов ровно в тот момент, когда сеть и так плохая.
 */
export async function flushPendingWishlist(): Promise<{ sent: number; left: number }> {
  const debts = readPending();
  if (debts.length === 0) return { sent: 0, left: 0 };

  let sent = 0;
  for (const debt of debts) {
    try {
      const res = await fetch('/api/tourist/wishlist', {
        method: debt.on ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType: debt.type, itemId: debt.id }),
      });
      // 401 — гость. Долг снимаем: висеть вечно он не должен, а после входа
      // человек поставит отметку заново, уже с аккаунтом.
      if (res.status === 401) { forgetPending(debt.type, debt.id); continue; }
      const data = await res.json().catch(() => ({})) as { success?: boolean };
      if (res.ok && data.success !== false) {
        forgetPending(debt.type, debt.id);
        sent++;
      }
      // Иначе долг остаётся: сервер ответил отказом, и молча забыть отметку
      // человека — то самое «сбой под видом успеха», ради которого всё это.
    } catch {
      // Связи по-прежнему нет — прекращаем проход целиком: остальные упрутся
      // в то же самое, а каждый упавший fetch стоит времени и батареи.
      break;
    }
  }
  return { sent, left: readPending().length };
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
      // Подтверждено сервером — долга больше нет (а он мог остаться от
      // прежнего офлайн-нажатия по этому же предмету).
      forgetPending(type, itemId);
      return { ok: true };
    }
    return { ok: false, error: data.error ?? 'Не удалось обновить избранное' };
  } catch {
    // Нет сети — отметка живёт локально до возвращения связи, и теперь это
    // правда: долг записан, flushPendingWishlist его дошлёт.
    writeLocal(type, itemId, on);
    rememberPending(type, itemId, on);
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
