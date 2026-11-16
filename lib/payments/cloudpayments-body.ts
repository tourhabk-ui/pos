/**
 * lib/payments/cloudpayments-body.ts — тело уведомления CloudPayments (Check,
 * Pay, Fail): форма или JSON, как выбрано в кабинете.
 *
 * По умолчанию CloudPayments шлёт форму (application/x-www-form-urlencoded);
 * JSON — если так настроено. Check разбирал оба формата, а Pay — только JSON:
 * при форме в кабинете каждая оплата отвечала бы 400, и ни одна не
 * записалась бы (#3433 п. 2, слово владельца 16.11 «Разбирать оба»). Теперь
 * разбор один на все уведомления.
 *
 * Подпись считается по сырому телу, поэтому разбор — после проверки подписи и
 * байтов не меняет. Числа формы приходят строками — приводятся здесь, чтобы
 * правила дальше видели то же, что при JSON.
 */

/** Поля, которые у CloudPayments числа: в форме они строки. */
const NUMERIC_FIELDS = ['TransactionId', 'Amount', 'PaymentAmount', 'StatusCode', 'ReasonCode'] as const;

/** Разобрать тело: объект полей или null, если это ни JSON-объект, ни форма. */
export function parseCloudPaymentsBody(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  const form = new URLSearchParams(trimmed);
  const out: Record<string, unknown> = {};
  for (const [key, value] of form) out[key] = value;
  if (Object.keys(out).length === 0) return null;
  for (const field of NUMERIC_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.replace(',', '.'));
      if (Number.isFinite(n)) out[field] = n;
    }
  }
  if (typeof out.TestMode === 'string') out.TestMode = out.TestMode === '1' || out.TestMode.toLowerCase() === 'true';
  return out;
}
