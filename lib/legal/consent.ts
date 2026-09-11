/**
 * Согласие посетителя на аналитику и рекламные скрипты.
 *
 * ── Третий исход есть и здесь (§4.0) ──────────────────────────────────────
 *
 * Состояний ТРИ, и они не сводятся к двум:
 *   `granted`  — человек согласился;
 *   `denied`   — человек отказался;
 *   `unknown`  — ещё не спрашивали, или ответ не читается (приватное окно,
 *                очищенное хранилище, отключённые site data).
 *
 * `unknown` — НЕ «согласился». Именно этой подменой живёт большинство
 * баннеров: не ответил — считаем, что можно. Здесь неизвестность приравнена
 * к отказу, потому что цена ошибки несимметрична: не загруженная аналитика
 * чинится следующим визитом, ушедшие данные не отзываются.
 *
 * Хранение — `localStorage`, то есть у самого посетителя. Согласие на
 * аналитику не стоит того, чтобы заводить ради него серверную запись с новым
 * идентификатором: это увеличило бы объём ПД ради учёта согласия на ПД.
 * Любой доступ обёрнут: в приватном окне обращение бросает, и падение здесь
 * не должно ронять страницу.
 */

export type ConsentState = 'granted' | 'denied' | 'unknown';

export interface ConsentChoice {
  analytics: boolean;
  advertising: boolean;
}

const KEY = 'vedar.consent.v1';

interface StoredConsent {
  analytics: boolean;
  advertising: boolean;
  /** Когда согласились — доказательство «когда», а не только «да». */
  at: string;
  /** Версия текста, на который согласились: текст изменится — спросим снова. */
  v: number;
}

/** Версия формулировки. Меняется вместе с составом получателей данных. */
export const CONSENT_VERSION = 1;

export function readConsent(): { state: ConsentState; choice: ConsentChoice } {
  const denied: ConsentChoice = { analytics: false, advertising: false };
  try {
    if (typeof window === 'undefined') return { state: 'unknown', choice: denied };
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { state: 'unknown', choice: denied };
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    // Состав получателей изменился — прежнее согласие было на другой текст.
    if (parsed.v !== CONSENT_VERSION) return { state: 'unknown', choice: denied };
    const choice: ConsentChoice = {
      analytics: parsed.analytics === true,
      advertising: parsed.advertising === true,
    };
    return {
      state: choice.analytics || choice.advertising ? 'granted' : 'denied',
      choice,
    };
  } catch {
    // Приватное окно, очищенные site data, запрет хранилища. Это «не знаю»,
    // и по правилу выше оно равно отказу — но молчать о нём нельзя.
    console.error('[consent] хранилище недоступно — считаем, что согласия нет');
    return { state: 'unknown', choice: denied };
  }
}

export function writeConsent(choice: ConsentChoice): void {
  try {
    if (typeof window === 'undefined') return;
    const value: StoredConsent = { ...choice, at: new Date().toISOString(), v: CONSENT_VERSION };
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Записать не удалось — значит на следующей странице спросим снова.
    // Это неудобно, но честно: несохранённое согласие не считается данным.
    console.error('[consent] выбор не сохранён — спросим снова');
  }
}
