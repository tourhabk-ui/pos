/**
 * lib/max/subscription-response.ts — разбор ответа API подписок MAX и
 * маскировка ключа подписки в том, что мы показываем.
 *
 * Исход. На `POST /subscriptions` и `DELETE /subscriptions?url=` MAX отвечает
 * `ActionResponse` — `{ success: true }` или `{ success: false, message }`
 * (тип в `@maxhub/max-bot-api` 0.3.1, `core/network/api/types/common.d.ts`).
 * `success: false` может прийти и с HTTP 200, поэтому одного `res.ok` мало:
 * крон засчитал бы снятие, которого не было, а старт — подписку, которой нет.
 * Ответ без поля `success` — не «успех», а «не смог проверить» (§4.0).
 *
 * Маскировка. Ключ подписки (`MAX_WEBHOOK_SECRET`) стоит в адресе подписки
 * `?s=<ключ>`, и сырой ответ MAX несёт его открытым текстом. С ключом
 * подделанный `bot_started` с `login-<nonce>` становится «заверенным», то есть
 * это вход в чужой аккаунт (#961). Поэтому всё, что уходит в ответ админке, в
 * лог или в сообщение, проходит `scrubMaxSecret`: значение `s=` любого адреса
 * и сам ключ (сырой и в URL-кодировке) заменяются на `[secret]`.
 */

export type MaxActionOutcome = { ok: true } | { ok: false; reason: string };

/** Строка без ключа подписки: и в адресе (`s=`), и где бы ни стоял сам ключ. */
function scrubText(text: string): string {
  let out = text.replace(/([?&]s=)[^&\s"'<>]+/g, '$1[secret]');
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (secret) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('[secret]');
    }
  }
  return out;
}

/**
 * Значение без ключа подписки: строки чистятся, объекты и массивы — обходом.
 * Для ответов MAX, которые показываем как есть (админка `/api/max/setup`).
 */
export function scrubMaxSecret(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubMaxSecret);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubMaxSecret(v)]));
  }
  return value;
}

/** Текст ошибки для лога и ответа: без ключа, не длиннее 200 знаков. */
export function scrubMaxReason(text: string): string {
  return scrubText(text).slice(0, 200);
}

/**
 * Исход действия с подпиской по ответу MAX: HTTP-код и поле `success`.
 * Причина отказа — код и `message` MAX, без ключа.
 */
export async function readMaxAction(res: Response): Promise<MaxActionOutcome> {
  let body: unknown = null;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    // Тело не JSON — это не «успех»: исход ниже назовёт «не разобран».
    parsed = false;
  }
  const field = (name: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  const rawMessage = field('message');
  const message = typeof rawMessage === 'string' && rawMessage ? scrubMaxReason(rawMessage) : '';

  if (!res.ok) {
    return { ok: false, reason: [`HTTP ${res.status}`, message].filter(Boolean).join(': ') };
  }
  const success = field('success');
  if (success === true) return { ok: true };
  if (success === false) {
    return { ok: false, reason: `HTTP ${res.status}, success: false${message ? `: ${message}` : ''}` };
  }
  return {
    ok: false,
    reason: parsed
      ? `HTTP ${res.status}, в ответе нет поля success — исход не проверен`
      : `HTTP ${res.status}, ответ не разобран — исход не проверен`,
  };
}
