/**
 * QR-эстафета SOS — store-and-forward через человека рядом.
 *
 * Браузер не умеет радио: Web Bluetooth не может рекламировать себя узлом,
 * WebRTC-мешу нужен серверный сигналинг (см. lib/mesh/volcano-mesh.ts) —
 * то есть НИКАКОЙ браузерный транспорт не доносит SOS между двумя офлайн
 * телефонами. А камера работает без сети всегда. Отсюда эстафета:
 *
 *   пострадавший показывает QR → попутчик сканирует (оба офлайн) →
 *   ссылка живёт у попутчика → когда ЕГО телефон добирается до связи,
 *   открытие ссылки доставляет SOS на сервер. Если у попутчика
 *   закэширована наша PWA — страница откроется офлайн сразу, и SOS
 *   ляжет в ЕГО офлайн-очередь (IndexedDB + Background Sync/флаш).
 *
 * Форма URL: /sos/relay?ll=<lat>,<lng>#p=<base64url(JSON)>
 * - координаты в query — чтобы URL был самоописывающимся в превью камеры:
 *   спасатель видит точку, даже не открывая страницу;
 * - весь payload (имя, телефон, сообщение) — в hash: фрагмент не уходит
 *   на сервер ни в логи, ни в реферер — ПД остаётся между двумя людьми
 *   до момента явной доставки.
 *
 * Ключи payload однобуквенные намеренно: ёмкость QR ограничена, и чем
 * короче строка, тем крупнее модули и надёжнее скан с грязного экрана.
 */

export interface QrSosPayload {
  sos_id: string;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  tourist_name: string | null;
  tourist_phone: string | null;
  message: string | null;
  /** Unix ms момента, когда пострадавший показал QR. */
  shown_at: number;
}

interface CompactPayload {
  i: string;
  a?: number;
  o?: number;
  c?: number;
  n?: string;
  p?: string;
  m?: string;
  t: number;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Округление координат до 5 знаков (~1 м) — точность GPS выше не бывает, а QR легче. */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000;
}

export function buildRelayUrl(origin: string, payload: QrSosPayload): string {
  const compact: CompactPayload = {
    i: payload.sos_id,
    t: payload.shown_at,
    ...(payload.lat != null ? { a: round5(payload.lat) } : {}),
    ...(payload.lng != null ? { o: round5(payload.lng) } : {}),
    ...(payload.accuracy != null ? { c: Math.round(payload.accuracy) } : {}),
    ...(payload.tourist_name ? { n: payload.tourist_name.slice(0, 60) } : {}),
    ...(payload.tourist_phone ? { p: payload.tourist_phone.slice(0, 20) } : {}),
    ...(payload.message ? { m: payload.message.slice(0, 120) } : {}),
  };
  const ll = payload.lat != null && payload.lng != null
    ? `?ll=${round5(payload.lat)},${round5(payload.lng)}`
    : '';
  return `${origin}/sos/relay${ll}#p=${toBase64Url(JSON.stringify(compact))}`;
}

/**
 * Разбор hash-фрагмента страницы эстафеты. Возвращает null на любом мусоре —
 * страница обязана отличать «нет данных» от «данные есть» и не показывать
 * пустую точку как сигнал (§4.0: не выдумывать то, чего нет).
 */
export function parseRelayHash(hash: string): QrSosPayload | null {
  const m = /(?:^|[#&])p=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  const json = fromBase64Url(m[1]);
  if (!json) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.i !== 'string' || c.i.length < 8 || c.i.length > 64) return null;
  if (typeof c.t !== 'number' || !Number.isFinite(c.t)) return null;

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown, max: number): string | null =>
    (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

  const lat = num(c.a);
  const lng = num(c.o);
  if (lat != null && (lat < -90 || lat > 90)) return null;
  if (lng != null && (lng < -180 || lng > 180)) return null;

  return {
    sos_id: c.i,
    shown_at: c.t,
    lat,
    lng,
    accuracy: num(c.c),
    tourist_name: str(c.n, 120),
    tourist_phone: str(c.p, 30),
    message: str(c.m, 500),
  };
}
