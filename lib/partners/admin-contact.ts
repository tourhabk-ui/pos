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
 * `contacts`. Сайт — наоборот: сперва `contacts.website` (его показывает
 * витрина и его меняет оператор в кабинете, app/api/hub/operator/profile),
 * потом `contact.website` (его пишет регистрация), потом колонка `website`.
 * Иначе форма показала бы сайт из регистрации, а сохранение откатило бы
 * правку оператора (ревью 23.10). Чего нет нигде — пусто, не выдумывается
 * (§4.0).
 *
 * Сохранение пишет сайт во все три места только если администратор его
 * поменял (`websiteWrite`): нажатие «Сохранить» ради описания сайт не трогает.
 * Непустой массив в `contacts` (люди «Камчатской рыбалки», 840–844) не
 * трогается вовсе — так же его берегут lib/partners/bind-channel.ts и
 * app/api/admin/operators/[id]/contacts.
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
    if (field === 'website') {
      const site = text(shown.website) || text(own.website) || text(website);
      if (site) out.website = site;
      else delete out.website;
      continue;
    }
    if (text(own[field])) continue;
    const fallback = text(shown[field]);
    if (fallback) out[field] = fallback;
  }
  return out;
}

export type WebsiteWrite = { changed: false } | { changed: true; value: string | null };

/**
 * Поменял ли администратор сайт. Сравнение — с тем, что форма показала бы
 * сейчас (`adminContactView` по текущей строке), а не с тем, что лежит в
 * одной из колонок: иначе каждое сохранение формы записывало бы сайт заново.
 */
export function websiteWrite(
  current: { contact: unknown; contacts: unknown; website: unknown },
  submitted: unknown,
): WebsiteWrite {
  const before = adminContactView(current.contact, current.contacts, current.website).website ?? '';
  const after = text(submitted);
  if (before === after) return { changed: false };
  return { changed: true, value: after || null };
}
