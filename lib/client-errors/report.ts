/**
 * lib/client-errors/report.ts — отправка ошибки браузера в ловушку.
 *
 * Решение владельца 13.10: «ловушку». До этого дня о падении страницы знал
 * только тот, у кого она упала: ни перехватчика, ни таблицы. Теперь
 * страница сама докладывает об ошибке на POST /api/client-errors, а
 * суточная перепись (client-errors-census) собирает их в список.
 *
 * Модуль без React и без node: его зовут и перехватчик окна
 * (components/shared/ClientErrorTrap), и границы React (app/error.tsx,
 * app/global-error.tsx).
 *
 * Правила:
 *   - шум не шлётся: расширения браузера, ResizeObserver, обезличенный
 *     «Script error.» чужого домена — это не наши баги;
 *   - одна и та же ошибка за загрузку шлётся один раз, и не больше
 *     MAX_PER_LOAD разных: цикл перерисовки с ошибкой в каждом кадре не
 *     должен заваливать приёмник;
 *   - офлайн (платформа offline-first) — ошибка ложится в очередь
 *     localStorage и досылается при появлении сети или при следующей
 *     загрузке, с временем, когда случилась;
 *   - личных данных здесь нет по построению: путь без query и фрагмента,
 *     остальное чистит сервер до записи.
 *
 * Отказ самой отправки некуда докладывать — ловушка не может сообщить о
 * своей поломке по тому же каналу; её здоровье видно переписью (строки
 * есть или нет) и smoke-пробой приёмника.
 */

export const CLIENT_ERRORS_ENDPOINT = '/api/client-errors';
export const MAX_PER_LOAD = 10;
export const QUEUE_KEY = 'vedar_err_queue';
export const MAX_QUEUE = 20;

export type ReportKind = 'error' | 'unhandledrejection' | 'boundary';

export interface ClientErrorPayload {
  kind: ReportKind;
  message: string;
  stack?: string;
  path: string;
  online: boolean;
  occurred_at: string;
}

const seen = new Set<string>();
let sentThisLoad = 0;

/** Только для тестов. */
export function resetReportState(): void {
  seen.clear();
  sentThisLoad = 0;
}

const NOISE: readonly RegExp[] = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /safari-(web-)?extension:\/\//,
];

/**
 * Событие DOM вместо ошибки (промис отклонён событием error у картинки,
 * скрипта, соединения). JSON.stringify такого события даёт только
 * {"isTrusted":true}: 23.10 так пришла ошибка с карточки маршрута, и
 * понять по ней, что упало, было нельзя. Называем род события, у кого оно
 * случилось и адрес ресурса — без query и фрагмента (там бывают ключи; сервер
 * чистит и сам, scrub.ts).
 */
function describeEvent(err: unknown): string | null {
  if (typeof Event === 'undefined' || !(err instanceof Event)) return null;
  const t = err.target as
    | (EventTarget & { tagName?: unknown; src?: unknown; href?: unknown; url?: unknown; error?: { name?: unknown } | null })
    | null;
  const who = !t ? '' : typeof t.tagName === 'string' ? t.tagName.toLowerCase() : (t.constructor?.name ?? '');
  const rawUrl = !t ? '' : [t.src, t.href, t.url].find((u): u is string => typeof u === 'string' && u !== '') ?? '';
  const url = rawUrl.startsWith('data:') ? 'data:' : rawUrl.split(/[?#]/)[0].slice(0, 200);
  const inner = t && t.error && typeof t.error.name === 'string' ? t.error.name : '';
  return [`Событие «${err.type || '?'}»`, who && `у ${who}`, url, inner && `(${inner})`].filter(Boolean).join(' ');
}

export function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || err.name || 'Error', stack: err.stack };
  if (typeof err === 'string') return { message: err };
  const ev = describeEvent(err);
  if (ev) return { message: ev };
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return { message: (err as { message: string }).message };
  }
  try { return { message: JSON.stringify(err).slice(0, 300) }; } catch { return { message: String(err) }; }
}

export function isNoise(message: string, stack?: string): boolean {
  return NOISE.some((re) => re.test(message) || (stack !== undefined && re.test(stack)));
}

export function buildPayload(
  kind: ReportKind,
  err: unknown,
  loc: { pathname: string },
  online: boolean,
  now: Date = new Date(),
): ClientErrorPayload | null {
  const { message, stack } = describeError(err);
  if (!message.trim() || isNoise(message, stack)) return null;
  return {
    kind,
    message: message.slice(0, 1000),
    stack: stack ? stack.slice(0, 4000) : undefined,
    path: loc.pathname || '/',
    online,
    occurred_at: now.toISOString(),
  };
}

/** Повтор — та же ошибка с того же места; номера строк и хэши сборки не считаются. */
function dedupeKey(p: ClientErrorPayload): string {
  const frame = ((p.stack ?? '').split('\n')[1] ?? '').replace(/\d+/g, '#').trim();
  return `${p.kind}|${p.message.slice(0, 200)}|${frame}`;
}

/** sendBeacon переживает закрытие вкладки; keepalive-fetch — запасной путь. */
function transmit(payload: ClientErrorPayload): boolean {
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      return navigator.sendBeacon(CLIENT_ERRORS_ENDPOINT, new Blob([body], { type: 'application/json' }));
    }
  } catch { /* ниже fetch */ }
  if (typeof fetch === 'function') {
    fetch(CLIENT_ERRORS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* докладывать об отказе доклада некуда */ });
    return true;
  }
  return false;
}

function readQueue(): ClientErrorPayload[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as ClientErrorPayload[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: ClientErrorPayload[]): void {
  try {
    if (items.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE)));
    else localStorage.removeItem(QUEUE_KEY);
  } catch { /* хранилище закрыто (приватный режим) — очередь не ведётся */ }
}

export function enqueue(payload: ClientErrorPayload): void {
  writeQueue([...readQueue(), payload]);
}

/** Дослать очередь, когда сеть есть. Возвращает, сколько ушло. */
export function flushQueue(): number {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  const items = readQueue();
  if (!items.length) return 0;
  writeQueue([]);
  let sent = 0;
  for (const item of items) if (transmit(item)) sent += 1;
  return sent;
}

/**
 * Доложить об ошибке. true — ушла или легла в очередь; false — отброшена
 * (шум, повтор, потолок, нет окна).
 */
export function reportClientError(kind: ReportKind, err: unknown): boolean {
  if (typeof window === 'undefined') return false;
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  const payload = buildPayload(kind, err, window.location, online);
  if (!payload) return false;
  const key = dedupeKey(payload);
  if (seen.has(key) || sentThisLoad >= MAX_PER_LOAD) return false;
  seen.add(key);
  sentThisLoad += 1;
  if (!online) {
    enqueue(payload);
    return true;
  }
  return transmit(payload);
}
