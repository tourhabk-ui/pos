/**
 * Просьба к service worker обновить прекэш под текущую сборку (10.11).
 *
 * Прекэш (SOS, «Связи нет», главная, полевой экран) кладётся при установке
 * воркера, а воркер переустанавливается только при смене `public/sw.js`.
 * Сборка же меняется на каждом пуше в main: HTML в памяти телефона ссылался на
 * файлы старой сборки, которых там не было, и без сети страница ломалась.
 * Теперь открытая онлайн страница называет воркеру свою сборку, и он
 * перекладывает прекэш вместе с файлами, если сборка новая.
 *
 * Метка сборки — адрес webpack-рантайма страницы: его хеш меняется с любым
 * чанком. Нет такого скрипта (другой сборщик) — просьбы нет, и это не ошибка:
 * воркер тогда живёт по прежнему правилу, прекэш при установке.
 */

/** Метка сборки по адресам скриптов страницы; null — опознать нечем. */
export function buildMarkFromScripts(srcs: readonly string[]): string | null {
  for (const src of srcs) {
    let path: string;
    try {
      path = new URL(src, 'https://vedarai.ru').pathname;
    } catch {
      continue;
    }
    if (/^\/_next\/static\/chunks\/webpack-[^/]+\.js$/.test(path)) return path;
  }
  return null;
}

interface ConnectionLike {
  saveData?: boolean;
}

/**
 * Просить ли сейчас: только при связи и без режима экономии трафика —
 * перекладка тянет HTML десятка страниц и их новые файлы.
 */
export function shouldAskShellRefresh(nav: { onLine: boolean; connection?: ConnectionLike }): boolean {
  if (!nav.onLine) return false;
  if (nav.connection?.saveData) return false;
  return true;
}

/** Отправить просьбу активному воркеру. false — некому или не о чем просить. */
export function askShellRefresh(doc: Document = document, nav: Navigator = navigator): boolean {
  if (!('serviceWorker' in nav)) return false;
  const conn = (nav as Navigator & { connection?: ConnectionLike }).connection;
  if (!shouldAskShellRefresh({ onLine: nav.onLine, connection: conn })) return false;
  const mark = buildMarkFromScripts(Array.from(doc.scripts, (s) => s.src).filter(Boolean));
  if (!mark) return false;
  const worker = nav.serviceWorker.controller;
  if (!worker) return false;
  worker.postMessage({ type: 'REFRESH_SHELL', build: mark });
  return true;
}
