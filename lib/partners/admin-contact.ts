/**
 * Контакты партнёра в форме админки — одно чтение из трёх мест хранения.
 *
 * Владелец 23.10 (снимок формы «Редактирование партнёра» у «Лагуны Прокат»):
 * «почему сайт не заполнен?». Форма читала только `partners.contact`, а
 * миграции партнёров (1318 «Лагуна», и так же другие посевы) кладут сайт,
 * почту и адрес в `partners.contacts` — блок связи для витрины, — а сайт ещё и
 * в колонку `partners.website` (692). Данные в базе были, форма их не видела и
 * показывала пустые поля, как будто их нет.
 *
 * Правило: значение из `contact` главнее; пустое поле дополняется из
 * `contacts`, сайт — ещё и из `website`. Сохранение формы пишет в `contact`
 * то, что видел администратор, — после первого сохранения расхождение уходит.
 * Чего нет нигде — остаётся пустым, не выдумывается (§4.0).
 */

export interface AdminContact {
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  [key: string]: unknown;
}

const FIELDS = ['phone', 'email', 'website', 'address'] as const;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function adminContactView(contact: unknown, contacts: unknown, website: unknown): AdminContact {
  const own = asObject(contact);
  const shown = asObject(contacts);
  const out: AdminContact = { ...own };
  for (const field of FIELDS) {
    if (text(own[field])) continue;
    const fallback = text(shown[field]) || (field === 'website' ? text(website) : '');
    if (fallback) out[field] = fallback;
  }
  return out;
}
