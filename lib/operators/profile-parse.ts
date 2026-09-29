/**
 * Разбор JSONB-полей публичного профиля оператора (partners) для страницы
 * /operators/[slug].
 *
 * Форму JSONB не гарантирует никто: contacts у «Камчатской рыбалки» — массив
 * людей с телефонами, у «Камчатка Семейный Рафтинг» — объект
 * {phone, phone2, admin_name, admin_name_2, telegram_channel, ...}. Страница
 * ждала только массив и падала 500 на .flatMap объекта (проба 109-110,
 * 15.08, прод d13277ad). Поэтому каждый разборщик принимает unknown и
 * молча возвращает пустоту на незнакомой форме — профиль без блока лучше
 * профиля-пятисотки.
 */

export interface ServiceItem {
  title: string;
  desc?: string;
  prices?: Record<string, string>;
  includes?: string[];
}

export interface FeatureItem {
  title: string;
  desc?: string;
  icon?: string;
}

export interface ContactItem {
  name?: string;
  role?: string;
  phone?: string;
  address?: string;
  /** Ссылка-канал (Telegram, WhatsApp, MAX, сайт): подпись + адрес. */
  label?: string;
  href?: string;
  /** Пояснение мелким текстом под строкой — например, часы звонков. */
  note?: string;
}

/**
 * Личный Telegram: username (`some_manager`) или номер телефона (`+79001234567`).
 * По номеру Telegram открывает чат ссылкой `t.me/+<цифры>` — так же стоят
 * ссылки на сайте «Камчатской рыбалки» (29.09). Ник — `t.me/<ник>`.
 * Незнакомая форма — пустая строка: мёртвая кнопка хуже её отсутствия.
 */
export function telegramContactHref(raw: unknown): string {
  const v = str(raw).replace(/^@/, '');
  // Ник Telegram начинается с буквы: «79147822222» ником не бывает, а
  // t.me/79147822222 ведёт на заглушку Telegram, а не в чат.
  if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) return `https://t.me/${v}`;
  const digits = v.replace(/[\s()-]/g, '');
  if (/^\+\d{10,15}$/.test(digits)) return `https://t.me/${digits}`;
  return '';
}

/**
 * MAX — только ссылка на профиль, которую дал сам партнёр: ссылки ПО НОМЕРУ
 * в MAX нет (см. tests/unit/max-contact.test.ts). Чужой хост кнопкой не станет.
 */
export function maxProfileHref(raw: unknown): string {
  const v = str(raw);
  return /^https:\/\/max\.ru\/[A-Za-z0-9_@.\-/]{2,64}$/.test(v) ? v : '';
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface LegalInfo {
  companyName?: string;
  inn?: string;
  ogrn?: string;
  address?: string;
  license?: string;
  fishingArea?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function extractServices(items: unknown): ServiceItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ title: item.trim() }];
    const r = asRecord(item);
    if (!r) return [];
    const title = str(r.title) || str(r.name);
    if (!title) return [];
    return [{
      title,
      desc: str(r.desc) || undefined,
      prices: (r.prices && typeof r.prices === 'object' && !Array.isArray(r.prices))
        ? r.prices as Record<string, string> : undefined,
      includes: Array.isArray(r.includes)
        ? r.includes.filter((x): x is string => typeof x === 'string') : undefined,
    }];
  });
}

export function extractFeatures(items: unknown): FeatureItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ title: item.trim() }];
    const r = asRecord(item);
    if (!r) return [];
    const title = str(r.title);
    if (!title) return [];
    return [{
      title,
      desc: str(r.desc) || undefined,
      icon: str(r.icon) || undefined,
    }];
  });
}

/** Массив людей: [{name, role, phone, address}, ...] или просто строки-телефоны. */
function contactsFromArray(items: unknown[]): ContactItem[] {
  return items.flatMap((item): ContactItem[] => {
    if (typeof item === 'string' && item.trim()) return [{ phone: item.trim() }];
    const r = asRecord(item);
    if (!r) return [];
    const c: ContactItem = {
      name: str(r.name) || undefined,
      role: str(r.role) || undefined,
      phone: str(r.phone) || undefined,
      address: str(r.address) || undefined,
    };
    return c.name || c.role || c.phone || c.address ? [c] : [];
  });
}

/**
 * Объект каналов: {phone, phone2, admin_name, admin_name_2, telegram_contact,
 * telegram_channel, whatsapp, website, address}. Людей собираем парами
 * админ+номер, каналы — ссылками. Ничего не выдумываем: нет поля — нет строки.
 */
function contactsFromObject(o: Record<string, unknown>): ContactItem[] {
  const out: ContactItem[] = [];

  const phone = str(o.phone);
  const phone2 = str(o.phone2);
  const hours = str(o.phone_hours);
  if (phone) out.push({ name: str(o.admin_name) || undefined, phone, note: hours || undefined });
  if (phone2) out.push({ name: str(o.admin_name_2) || undefined, phone: phone2 });

  const tgc = telegramContactHref(o.telegram_contact);
  if (tgc) out.push({ label: 'Написать в Telegram', href: tgc });

  const tg = str(o.telegram_channel);
  if (tg.startsWith('https://t.me/')) {
    out.push({ label: 'Telegram-канал', href: tg });
  }

  const wa = str(o.whatsapp).replace(/[^\d]/g, '');
  if (/^\d{10,15}$/.test(wa)) {
    out.push({ label: 'WhatsApp', href: `https://wa.me/${wa}` });
  }

  const max = maxProfileHref(o.max);
  if (max) out.push({ label: 'Написать в MAX', href: max });

  const tiktok = str(o.tiktok).replace(/^@/, '');
  if (/^[\w.]{2,24}$/.test(tiktok)) {
    out.push({ label: 'TikTok', href: `https://www.tiktok.com/@${tiktok}` });
  }

  const email = str(o.email);
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    out.push({ label: email, href: `mailto:${email}` });
  }

  const site = str(o.website);
  if (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(site)) {
    out.push({ label: 'Сайт оператора', href: site });
  }

  const address = str(o.address);
  if (address) out.push({ address });

  return out;
}

export function extractContacts(items: unknown): ContactItem[] {
  if (Array.isArray(items)) return contactsFromArray(items);
  const o = asRecord(items);
  return o ? contactsFromObject(o) : [];
}

export function extractFaq(items: unknown): FaqItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): FaqItem[] => {
    const r = asRecord(item);
    if (!r) return [];
    const q = str(r.q);
    const a = str(r.a);
    return q && a ? [{ q, a }] : [];
  });
}

export function extractGallery(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function extractLegalInfo(raw: unknown): LegalInfo | string | null {
  if (!raw) return null;
  if (typeof raw === 'string' && raw.trim()) return raw;
  const r = asRecord(raw);
  if (!r) return null;
  return {
    companyName: str(r.companyName) || undefined,
    inn: str(r.inn) || undefined,
    ogrn: str(r.ogrn) || undefined,
    address: str(r.address) || undefined,
    license: str(r.license) || undefined,
    fishingArea: str(r.fishingArea) || undefined,
  };
}
