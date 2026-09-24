/**
 * Подвал AI-канала — три реферальные ссылки владельца (решение владельца 24.09:
 * «нужно 3 реферальные ссылки в конце»).
 *
 * Один источник на все наши публикации в AI-канал: дайджест разведчика
 * (`lib/agents/scout-digest.ts`) и новость (`postAINewsToChannel`). Две копии
 * подвала разошлись бы при первой же замене ссылки.
 *
 * Подвал добавляется ПОСЛЕ фактчека и текстовых ворот: судья сверяет
 * утверждения поста с источниками, а подвал утверждений о новости не несёт —
 * показывать его судье значило бы получить «неподтверждённое» на ровном месте.
 *
 * Подписи — формулировки владельца из его же постов канала, без эмодзи
 * (правило платформы). Ссылки — ровно как владелец их дал, с параметрами:
 * по ним считается, откуда пришёл человек.
 */

export interface ChannelReferral {
  label: string;
  link: string;
  url: string;
}

export const AI_CHANNEL_REFERRALS: readonly ChannelReferral[] = [
  { label: 'Карта для оплаты AI', link: 'открыть бота', url: 'https://telegram.me/WantToPayBot?start=w17851188--XYBXD' },
  { label: 'Неделя Claude Pro в подарок', link: 'забрать', url: 'https://claude.ai/referral/PzwnMtcV4A?s=android' },
  { label: 'Manus по приглашению', link: 'открыть', url: 'https://manus.im/invitation/ZPITNRPMOEFT?utm_source=invitation&utm_medium=social&utm_campaign=system_share' },
];

/** `&` в адресе обязан быть `&amp;`: иначе Telegram примет его за начало сущности. */
function escapeHref(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Подвал в Telegram HTML — по строке на ссылку. */
export function aiChannelFooter(): string {
  return AI_CHANNEL_REFERRALS
    .map((r) => `${r.label}: <a href="${escapeHref(r.url)}">${r.link}</a>`)
    .join('\n');
}

/**
 * Пост + подвал. `limit` — потолок сообщения (4096 у текста, 1024 у подписи
 * к фото). Не влезает — ужимается ТЕЛО, а не подвал: иначе общий срез под
 * потолок отрезал бы ссылки первыми, ведь они в конце.
 */
export function withAiChannelFooter(
  body: string,
  limit: number,
  fit: (text: string, limit: number) => string,
): string {
  const footer = aiChannelFooter();
  const sep = '\n\n';
  const room = limit - footer.length - sep.length;
  const trimmed = body.trimEnd();
  const fitted = trimmed.length > room ? fit(trimmed, room) : trimmed;
  return `${fitted}${sep}${footer}`;
}
