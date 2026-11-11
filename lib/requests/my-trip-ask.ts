/**
 * lib/requests/my-trip-ask.ts
 *
 * Фраза и кнопка «Моя поездка» (#2970) — без базы и сети: их читают
 * клавиатура туриста и «код раньше модели», которым база ради надписи
 * не нужна. Сам ответ — lib/requests/my-trip.
 */

/** Надпись кнопки — одна на MAX и Telegram. */
export const MY_TRIP_BUTTON = 'Моя поездка';

/** Фразы, на которые отвечает «Моя поездка». Целой репликой: вопрос с подробностями — модели. */
const MY_TRIP_ASK = /^(?:моя\s+поездка|мои\s+поездки|мои\s+заявки|моя\s+заявка|что\s+с\s+(?:моей\s+)?заявкой|статус\s+(?:моей\s+)?заявки)\s*[?!.]*$/i;

export function isMyTripAsk(text: string): boolean {
  return MY_TRIP_ASK.test(text.trim().replace(/ё/gi, 'е'));
}

// ── «Написать оператору» под «Моей поездкой» (#2970, шаг 3) ─────────────────
// Разбор кнопки — здесь, без базы: его зовёт маршрутизатор нажатий MAX
// (lib/max/verified-press). Само нажатие — lib/requests/my-trip-write.

/** Цель переписки: лид или заявка на жильё (как ChatTarget lib/requests/request-chat). */
export interface MyTripWriteTarget {
  kind: 'lead' | 'stay';
  id: string;
}

const PREFIX = 'mw:';
/** `mw:l<32 hex>` — лид, `mw:a<32 hex>` — заявка на жильё. Без дефисов: кнопка с подписью ≤ 64 байт. */
const PAYLOAD_RE = /^mw:([la])([0-9a-f]{32})$/;

const compact = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function myTripWritePayload(target: MyTripWriteTarget): string {
  return `${PREFIX}${target.kind === 'stay' ? 'a' : 'l'}${compact(target.id)}`;
}

export function isMyTripWritePayload(payload: string): boolean {
  return payload.startsWith(PREFIX);
}

export function parseMyTripWrite(payload: string): MyTripWriteTarget | null {
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return { kind: m[1] === 'a' ? 'stay' : 'lead', id: uuidOf(m[2]!) };
}

/** Надпись кнопки: у заявки на жильё адресат — хозяин, у прочих — оператор. */
export function myTripWriteText(target: MyTripWriteTarget, n: number | null): string {
  const who = target.kind === 'stay' ? 'Написать хозяину' : 'Написать оператору';
  return n === null ? who : `${who} · ${n}`;
}
