/**
 * lib/mcp/human-confirmation.ts — заявка внешнего агента в два вызова
 * (#3399, п. 4; карт-бланш владельца 15.11).
 *
 * До этого согласие человека на передачу имени и телефона было флагом
 * `consent: true`, который ставит сам агент: сервер не знал, видел ли человек,
 * кому и что уйдёт. У проката так было с 24.10 (lib/mcp/rental-confirmation),
 * теперь — у всех заявок MCP и A2A:
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
 * Чат Кузьмича этого шага не проходит: там человек сам видит сводку и
 * отвечает «да» (lib/kuzmich/pending-request), а согласие пишется каналом чата.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

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

function mac(s: string, expMin: number, canon: string): string {
  return createHmac('sha256', s).update(`human-confirm:${expMin}:${canon}`).digest('base64url').slice(0, 22);
}

/** Код подтверждения или null, если секрета нет. */
export function issueHumanConfirmation(tool: string, args: Record<string, unknown>, now = Date.now()): string | null {
  const s = secret();
  if (!s) return null;
  const expMin = Math.floor(now / 60000) + HUMAN_CONFIRM_TTL_MIN;
  return `${expMin.toString(36)}.${mac(s, expMin, confirmationCanon(tool, args))}`;
}

export type HumanConfirmCheck = 'ok' | 'expired' | 'mismatch' | 'unavailable';

export function checkHumanConfirmation(code: string, tool: string, args: Record<string, unknown>, now = Date.now()): HumanConfirmCheck {
  const s = secret();
  if (!s) return 'unavailable';
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m) return 'mismatch';
  const expMin = parseInt(m[1], 36);
  const want = Buffer.from(mac(s, expMin, confirmationCanon(tool, args)));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'mismatch';
  return Math.floor(now / 60000) > expMin ? 'expired' : 'ok';
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
