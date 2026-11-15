/**
 * lib/mcp/human-confirmation.ts — заявка внешнего агента в два вызова
 * (#3399, п. 4; карт-бланш владельца 15.11).
 *
 * До этого заявку можно было отправить одним вызовом: агент ставил
 * `consent: true` и в том же вызове передавал имя и телефон, не показав
 * человеку, кому и что уйдёт. У проката два шага с 24.10
 * (lib/mcp/rental-confirmation), теперь — у всех заявок MCP и A2A:
 *
 * - первый вызов без `confirmation` проходит все проверки заявки, но ничего
 *   не записывает и никому не передаёт: агент получает черновик для человека
 *   и код подтверждения;
 * - второй вызов с теми же полями, `consent: true` и этим кодом — запись.
 *
 * Код привязан к инструменту и полям заявки (кроме самого кода, согласия и
 * пробного флага) и живёт HUMAN_CONFIRM_TTL_MIN минут: поменялись данные —
 * новый черновик. Хранилища нет: код — HMAC на секрете сервера. Секрета нет —
 * отказ, заявку без первого шага не пускаем.
 *
 * Чего код НЕ доказывает (ревью безопасности #3414): что «да» сказал человек.
 * Код получает тот же агент и может погасить его сам. Код делает черновик
 * обязательным шагом перед записью и связывает запись с полями, которые в
 * черновике стояли; согласие по-прежнему заявлено агентом, и запись согласия
 * так и помечена (источник `mcp`). Согласие человека подтверждает он сам —
 * на странице статуса заявки или в чате Кузьмича.
 *
 * Код одноразовый: погашенный второй раз не пускает (у жилья повторы заявок
 * не склеиваются, и один код иначе дал бы несколько заявок). Учёт погашенных —
 * в памяти процесса до конца срока кода: потеря при перезапуске оставляет код
 * годным до его 30 минут, не дольше.
 *
 * Чат Кузьмича этого шага не проходит: там человек сам видит сводку и
 * отвечает «да» (lib/kuzmich/pending-request), а согласие пишется каналом чата.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HUMAN_CONFIRM_TTL_MIN = 30;

/** Поля, которые в код не входят: сам код, согласие и пробный флаг. */
const OUTSIDE_CODE = new Set(['confirmation', 'consent', 'test']);

function secret(): string | null {
  return process.env.MCP_HASH_SALT || process.env.CRON_SECRET || null;
}

/** Поля заявки в одном порядке, строки без пробелов по краям. */
export function confirmationCanon(tool: string, args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown =>
    typeof v === 'string' ? v.trim()
      : Array.isArray(v) ? v.map(norm)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
          : v;
  const fields = Object.keys(args).filter((k) => !OUTSIDE_CODE.has(k) && args[k] !== undefined && args[k] !== null && args[k] !== '').sort();
  return JSON.stringify([tool, fields.map((k) => [k, norm(args[k])])]);
}

function mac(s: string, expMin: number, nonce: string, canon: string): string {
  return createHmac('sha256', s).update(`human-confirm:${expMin}:${nonce}:${canon}`).digest('base64url').slice(0, 22);
}

/**
 * Код подтверждения или null, если секрета нет. Случайная часть делает каждый
 * черновик своим кодом: без неё новый черновик на те же поля в ту же минуту
 * получил бы уже погашенный код.
 */
export function issueHumanConfirmation(tool: string, args: Record<string, unknown>, now = Date.now()): string | null {
  const s = secret();
  if (!s) return null;
  const expMin = Math.floor(now / 60000) + HUMAN_CONFIRM_TTL_MIN;
  const nonce = randomBytes(6).toString('base64url');
  return `${expMin.toString(36)}.${nonce}.${mac(s, expMin, nonce, confirmationCanon(tool, args))}`;
}

export type HumanConfirmCheck = 'ok' | 'expired' | 'mismatch' | 'used' | 'unavailable';

/** Погашенные коды → минута, после которой код истёк бы сам. */
const spent = new Map<string, number>();

/**
 * Погасить код после успешной сверки: второй раз он не пустит. Вызывать
 * только для кода со сверкой 'ok', перед записью.
 */
export function spendHumanConfirmation(code: string, now = Date.now()): void {
  const nowMin = Math.floor(now / 60000);
  for (const [c, exp] of spent) if (exp < nowMin) spent.delete(c);
  const exp = parseInt(code.split('.')[0] ?? '', 36);
  spent.set(code.trim(), Number.isFinite(exp) ? exp : nowMin + HUMAN_CONFIRM_TTL_MIN);
}

export function checkHumanConfirmation(code: string, tool: string, args: Record<string, unknown>, now = Date.now()): HumanConfirmCheck {
  const s = secret();
  if (!s) return 'unavailable';
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m) return 'mismatch';
  const expMin = parseInt(m[1], 36);
  const want = Buffer.from(mac(s, expMin, m[2], confirmationCanon(tool, args)));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'mismatch';
  if (Math.floor(now / 60000) > expMin) return 'expired';
  return spent.has(code.trim()) ? 'used' : 'ok';
}

/** Что агент делает с черновиком: показать человеку и спросить прямо. */
export function askHumanLine(code: string): string {
  return 'Черновик: заявка ещё НЕ создана и никому не передана. Покажи его человеку и прямо спроси: '
    + '«Согласны ли вы на обработку имени и телефона и их передачу адресату заявки и отправить её?» '
    + `Только после явного «да» самого человека повтори вызов с теми же полями, consent: true и confirmation: "${code}" `
    + `(код действует ${HUMAN_CONFIRM_TTL_MIN} мин; поменялись данные — будет новый черновик). Не ставь consent: true сам и не придумывай имя и телефон. `
    + `EN: Draft only — not sent. Show it to the person; only after their explicit "yes" repeat the call with the same fields, consent: true and confirmation: "${code}".`;
}

/** Черновик заявки: что уйдёт и кому — без имени и телефона (ответ идёт в модель). */
export function draftText(would: string, recipient: string | null): string {
  const who = recipient ?? 'менеджеру Ведара';
  return `Черновик заявки (не отправлена): ${would} Имя и телефон, которые вы передали, уйдут ${who}.`;
}
