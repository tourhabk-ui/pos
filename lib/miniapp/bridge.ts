/**
 * Мост мини-приложения MAX — то немногое, что нужно узкому входу в карту
 * (`/map/compact`, docs/CHAT_MINIAPPS_PLAN.md §6.1).
 *
 * MAX кладёт в окно объект `window.WebApp` (скрипт
 * `https://st.max.ru/js/max-web-app.js`, dev.max.ru/docs/webapps/bridge,
 * прочитано 27.11). Скрипт грузится и в обычном браузере, поэтому «мы внутри
 * MAX» — не наличие объекта, а непустая строка `initData`: её MAX передаёт
 * только запущенному в нём приложению.
 *
 * У каждого метода есть исход «не поддерживается здесь»: нет моста, нет
 * метода, метод бросил — `false`, и вызывающий идёт обычным путём. Здесь нет
 * входа и проверки подписи: `initData` не читается дальше «пуста ли» и
 * никуда не пишется (план §6.2, гигиена логов).
 */

/** Адрес скрипта моста MAX — тот же, что разрешён CSP узкого входа (next.config.js). */
export const MAX_BRIDGE_SRC = 'https://st.max.ru/js/max-web-app.js';

export interface MiniAppBridge {
  platform: 'max';
  /** Открыть адрес во внешнем браузере. Не вышло — false. */
  openLink(url: string): boolean;
}

interface MaxWebApp {
  initData?: unknown;
  openLink?: unknown;
}

/** Мост, если страница открыта внутри MAX. Иначе — null. */
export function miniAppBridge(w: unknown = typeof window !== 'undefined' ? window : undefined): MiniAppBridge | null {
  const app = w && typeof w === 'object' ? (w as { WebApp?: MaxWebApp }).WebApp : undefined;
  if (!app || typeof app !== 'object') return null;
  if (typeof app.initData !== 'string' || app.initData.length === 0) return null;
  const open = app.openLink;
  if (typeof open !== 'function') return null;
  return {
    platform: 'max',
    openLink(url: string): boolean {
      try {
        open.call(app, url);
        return true;
      } catch (err) {
        console.error('[miniapp] openLink не сработал:', err instanceof Error ? err.name : 'unknown');
        return false;
      }
    },
  };
}
