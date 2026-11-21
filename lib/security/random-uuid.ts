/**
 * UUID v4 в браузере, где `crypto.randomUUID` нет.
 *
 * 21.11 владелец открыл /sos на экране в машине (старый Chrome на Android), и
 * страница упала при открытии: экран SOS в рендере звал
 * `crypto.randomUUID()`, а его в Chrome нет до 92-й версии. Объект `crypto`
 * при этом есть, поэтому проверка `typeof crypto !== 'undefined'` не спасала:
 * «crypto.randomUUID is not a function», и вместо SOS — «Произошла ошибка».
 *
 * Запасной путь — `crypto.getRandomValues` (есть с Chrome 11), тот же формат
 * v4. Криптографии нет вовсе — `null`, и вызывающий решает сам: идентификатор
 * сверки повторов может взять время, секрет — нет (§4.0: «не знаю» не
 * подменяется угадываемым значением).
 *
 * В клиентском коде `crypto.randomUUID()` зовут только через эту функцию или
 * со своей проверкой наличия — сторож `tests/unit/client-random-uuid.test.tsx`.
 */

type CryptoLike = {
  randomUUID?: unknown;
  getRandomValues?: unknown;
};

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
}

/** `source` — для сторожа; по умолчанию `globalThis.crypto`. */
export function randomUuid(source?: CryptoLike | null): string | null {
  const c: CryptoLike | undefined | null =
    source === undefined ? (typeof crypto !== 'undefined' ? (crypto as unknown as CryptoLike) : undefined) : source;
  if (!c) return null;
  if (typeof c.randomUUID === 'function') {
    return (c.randomUUID as () => string).call(c);
  }
  if (typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    (c.getRandomValues as (a: Uint8Array) => Uint8Array).call(c, bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
    const h = hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

/**
 * Идентификатор для сверки повторов (не секрет): UUID, а без криптографии —
 * время и случайная часть. Так помечают сигнал SOS и сообщения меша: дубль
 * лучше потери, а упасть экрану SOS из-за id нельзя.
 */
export function dedupId(prefix: string): string {
  return randomUuid() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
