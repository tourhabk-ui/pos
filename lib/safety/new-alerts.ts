/**
 * Какие предупреждения появились с прошлого визита (12.11, «Перед выходом:
 * новое предупреждение один раз подсвечивается»).
 *
 * «Новое» значит «этот браузер его ещё не показывал», а не «свежая дата»:
 * человек, открывший главную вчера, должен заметить то, чего вчера не было.
 * В первый визит подсветки нет вовсе — нового относительно ничего не бывает,
 * и подсветить всё значило бы не подсветить ничего. Список виденного живёт
 * только в браузере и сбрасывается вместе с его данными: тогда снова первый
 * визит, без подсветки.
 */

import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const SEEN_ALERTS_KEY = 'vedar:alerts-seen';
/** Сколько ключей помнить: лента редко длиннее пары десятков. */
export const SEEN_ALERTS_CAP = 200;
/** Сколько держится подсветка нового, мс. */
export const NEW_ALERT_HIGHLIGHT_MS = 2600;

export interface AlertKeyInput { title: string; at: string | null }

/** У предупреждения ленты нет id — ключ из заголовка и времени выпуска. */
export function alertKey(a: AlertKeyInput): string {
  return `${a.title}|${a.at ?? ''}`;
}

/** Новые ключи; `seen === null` — первый визит, нового нет. */
export function newAlertKeys(current: readonly string[], seen: readonly string[] | null): Set<string> {
  if (seen === null) return new Set();
  const had = new Set(seen);
  return new Set(current.filter((k) => !had.has(k)));
}

/** Что запомнить после показа: текущие впереди, затем прежние, с потолком. */
export function nextSeen(current: readonly string[], seen: readonly string[] | null): string[] {
  const out: string[] = [];
  const add = (k: string) => { if (!out.includes(k)) out.push(k); };
  current.forEach(add);
  (seen ?? []).forEach(add);
  return out.slice(0, SEEN_ALERTS_CAP);
}

export function readSeen(storage: Pick<Storage, 'getItem'> | null): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SEEN_ALERTS_KEY);
    if (raw == null) return null;
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

export function writeSeen(storage: Pick<Storage, 'setItem'> | null, keys: string[]): void {
  if (!storage) return;
  try {
    storage.setItem(SEEN_ALERTS_KEY, JSON.stringify(keys));
  } catch (err) {
    // Хранилище закрыто или полно: подсветка не запомнится, лента та же.
    logSwallowedFailure('new-alerts', 'запись показанных предупреждений', err);
  }
}
