/**
 * Ключ пробного запуска WebMCP в Chrome (Origin Trial: Chrome 149–156,
 * продлён до 162 на компьютере — Chrome Status, запись от 11.11.2026,
 * https://chromestatus.com/feature/5117755740913664).
 *
 * Пока API не вышел в обычный Chrome (версия выхода в Chrome Status не
 * названа), у посетителя он включается только на сайте с ключом пробного
 * запуска в `<head>`. Ключ
 * выдаёт Chrome Origin Trials на домен vedarai.ru, получает его владелец.
 * Ключ нужен собственный, без «Third-party matching»: сторонний ключ Chrome
 * из `<meta>` не принимает (проверка в Chrome 156 28.11.2026, #3563).
 * Значение публичное по природе (браузер читает его из HTML любой страницы),
 * но живёт в переменной окружения Timeweb, а не в коде: ключ пробного
 * запуска истекает, и замена не должна ждать PR и выката (тот же довод, что
 * у китайских вебмастеров, lib/seo/site-verification).
 *
 * Пустая или незаданная переменная — тега нет вовсе. Значение не похоже на
 * ключ (не base64 или неправдоподобной длины) — тега тоже нет, и причина
 * пишется в лог один раз за жизнь процесса: молча выброшенный ключ выглядел
 * бы как «браузер не поддерживает».
 */

export const WEBMCP_ORIGIN_TRIAL_ENV = 'WEBMCP_ORIGIN_TRIAL_TOKEN';

/** Ключ Origin Trial — base64 подписи и полезной нагрузки, сотни знаков. */
const TOKEN_SHAPE = /^[A-Za-z0-9+/]{40,4096}={0,2}$/;

let warned = false;

/** Ключ для `<meta http-equiv="origin-trial">` или null — тега нет. */
export function webmcpOriginTrialToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[WEBMCP_ORIGIN_TRIAL_ENV];
  if (raw === undefined) return null;
  const token = raw.trim();
  if (token.length === 0) return null;
  if (TOKEN_SHAPE.test(token)) return token;
  if (!warned) {
    warned = true;
    console.error(`[webmcp] ${WEBMCP_ORIGIN_TRIAL_ENV} задана, но не похожа на ключ пробного запуска (длина ${token.length}); тег не выводится`);
  }
  return null;
}
