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
  /** Ссылка-канал (Telegram, WhatsApp, сайт): подпись + адрес. */
  label?: string;
  href?: string;
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
  if (phone) out.push({ name: str(o.admin_name) || undefined, phone });
  if (phone2) out.push({ name: str(o.admin_name_2) || undefined, phone: phone2 });

  const tgc = str(o.telegram_contact).replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(tgc)) {
    out.push({ label: 'Написать в Telegram', href: `https://t.me/${tgc}` });
  }

  const tg = str(o.telegram_channel);
  if (tg.startsWith('https://t.me/')) {
    out.push({ label: 'Telegram-канал', href: tg });
  }

  const wa = str(o.whatsapp).replace(/[^\d]/g, '');
  if (/^\d{10,15}$/.test(wa)) {
    out.push({ label: 'WhatsApp', href: `https://wa.me/${wa}` });
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
