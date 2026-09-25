/**
 * Код креатора переживает уход со страницы.
 *
 * ── Что чинилось 20.09 (issue #1978) ──────────────────────────────────────
 *
 * Бронь брала агентский код из АДРЕСНОЙ СТРОКИ в момент нажатия кнопки.
 * Значит атрибуция выживала ровно одно посещение: ушёл на другую страницу,
 * вернулся назавтра, открыл ссылку из мессенджера, срезавшего параметры, —
 * привязка потеряна, блогер не получает ничего и доказать обратное нечем.
 * Для покупки за десятки тысяч «вернулся назавтра» — норма.
 *
 * Правильный механизм в платформе уже был — память на 30 дней в
 * `lib/referral/link.ts`, — но только для ПОЛЬЗОВАТЕЛЬСКИХ приглашений, и
 * тот файл прямо запрещает смешивать его с агентскими: разные сущности,
 * разные выплаты.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * 1. Два кода не смешиваются НИ В ОДНУ сторону. Чужой код в своём хранилище
 *    хуже отсутствующего: он выглядит рабочим.
 * 2. Адрес сильнее памяти. Пришёл по ссылке прямо сейчас — привёл этот
 *    блогер, а не вчерашний.
 * 3. Срок кончается. Код полугодовой давности приписал бы покупку тому, кто
 *    к решению уже не причастен.
 * 4. Клик считается независимо от того, куда ведёт ссылка.
 * 5. Короткая ссылка не пишет ничего на неизвестный код и не собирает
 *    персональных данных ради счётчика.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAgentReferralCode,
  readAgentReferralFromSearch,
  saveAgentReferral,
  loadAgentReferral,
  agentReferralForBooking,
  forgetAgentReferral,
  AGENT_REFERRAL_STORAGE_KEY,
  AGENT_REFERRAL_TTL_MS,
} from '@/lib/referral/agent-link';
import { isUserReferralCode, REFERRAL_STORAGE_KEY } from '@/lib/referral/link';

const ROOT = process.cwd();
const SHORT   = readFileSync(join(ROOT, 'app/r/[code]/route.ts'), 'utf-8');
const CAPTURE = readFileSync(join(ROOT, 'components/shared/ReferralCapture.tsx'), 'utf-8');
// С 26.09 код ссылки шлёт главная форма брони (BookingFormClient); модалка
// TourPaymentModal — лишь её рамка.
const MODAL   = readFileSync(join(ROOT, 'components/marketplace/BookingFormClient.tsx'), 'utf-8');

const AGENT = 'KH-AGT-1A2B3C';
const USER  = 'KH-1A2B3C';

/** Хранилище в памяти: модуль обязан работать без браузера. */
function useMemoryStorage() {
  const box = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => { box.set(k, v); },
    removeItem: (k: string) => { box.delete(k); },
  });
  return box;
}

describe('два кода не смешиваются', () => {
  it('агентский формат отличается от пользовательского в обе стороны', () => {
    expect(isAgentReferralCode(AGENT)).toBe(true);
    expect(isAgentReferralCode(USER)).toBe(false);
    expect(isUserReferralCode(AGENT)).toBe(false);
    expect(isUserReferralCode(USER)).toBe(true);
  });

  it('хранилища разные', () => {
    expect(AGENT_REFERRAL_STORAGE_KEY).not.toBe(REFERRAL_STORAGE_KEY);
  });

  it('ловец из адреса берёт только свой код', () => {
    expect(readAgentReferralFromSearch(`?ref=${AGENT}`)).toBe(AGENT);
    expect(readAgentReferralFromSearch(`?ref=${USER}`)).toBeNull();
    expect(readAgentReferralFromSearch('?ref=мусор')).toBeNull();
    expect(readAgentReferralFromSearch('')).toBeNull();
  });

  it('регистр не мешает: код приводится к верхнему', () => {
    expect(readAgentReferralFromSearch('?ref=kh-agt-1a2b3c')).toBe(AGENT);
  });

  it('оба ловца стоят в одном месте и пишут каждый в своё', () => {
    expect(CAPTURE).toMatch(/saveReferral\(/);
    expect(CAPTURE).toMatch(/saveAgentReferral\(/);
  });
});

describe('память и срок', () => {
  beforeEach(() => { useMemoryStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('сохранённый код читается обратно', () => {
    const now = 1_700_000_000_000;
    saveAgentReferral(AGENT, now);
    expect(loadAgentReferral(now)).toBe(AGENT);
  });

  it('чужой код в агентское хранилище не кладётся', () => {
    const now = 1_700_000_000_000;
    saveAgentReferral(USER, now);
    expect(loadAgentReferral(now)).toBeNull();
  });

  it('через тридцать дней код ещё жив, через тридцать один — нет', () => {
    const now = 1_700_000_000_000;
    saveAgentReferral(AGENT, now);
    expect(loadAgentReferral(now + AGENT_REFERRAL_TTL_MS - 1)).toBe(AGENT);
    expect(loadAgentReferral(now + AGENT_REFERRAL_TTL_MS + 1)).toBeNull();
  });

  it('протухший код стирается, а не остаётся лежать', () => {
    const now = 1_700_000_000_000;
    saveAgentReferral(AGENT, now);
    loadAgentReferral(now + AGENT_REFERRAL_TTL_MS + 1);
    expect(localStorage.getItem(AGENT_REFERRAL_STORAGE_KEY)).toBeNull();
  });

  it('мусор в хранилище не роняет и не выдаётся за код', () => {
    localStorage.setItem(AGENT_REFERRAL_STORAGE_KEY, 'не json');
    expect(loadAgentReferral(Date.now())).toBeNull();
    localStorage.setItem(AGENT_REFERRAL_STORAGE_KEY, JSON.stringify({ code: AGENT }));
    expect(loadAgentReferral(Date.now())).toBeNull();
  });

  it('забыть — значит забыть', () => {
    const now = Date.now();
    saveAgentReferral(AGENT, now);
    forgetAgentReferral();
    expect(loadAgentReferral(now)).toBeNull();
  });

  it('недоступное хранилище не ломает страницу', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('приватный режим'); },
      setItem: () => { throw new Error('приватный режим'); },
      removeItem: () => { throw new Error('приватный режим'); },
    });
    expect(() => saveAgentReferral(AGENT, Date.now())).not.toThrow();
    expect(loadAgentReferral(Date.now())).toBeNull();
    expect(() => forgetAgentReferral()).not.toThrow();
  });
});

describe('адрес сильнее памяти', () => {
  beforeEach(() => { useMemoryStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('пришёл по НОВОЙ ссылке — привёл новый блогер', () => {
    const now = Date.now();
    saveAgentReferral(AGENT, now);
    expect(agentReferralForBooking('?ref=KH-AGT-999999', now)).toBe('KH-AGT-999999');
  });

  it('адреса нет — берётся память', () => {
    const now = Date.now();
    saveAgentReferral(AGENT, now);
    expect(agentReferralForBooking('', now)).toBe(AGENT);
  });

  it('ни адреса, ни памяти — null, а не пустая строка', () => {
    expect(agentReferralForBooking('', Date.now())).toBeNull();
  });

  it('бронь зовёт именно это правило, а не читает адрес сама', () => {
    expect(MODAL).toMatch(/agentReferralForBooking\(/);
    // Прежняя форма брала код прямо из адресной строки и теряла его при
    // любом уходе со страницы.
    expect(MODAL).not.toMatch(/URLSearchParams\(window\.location\.search\)\.get\('ref'\)/);
  });
});

describe('короткая ссылка считает клик где угодно', () => {
  it('роут существует и это GET', () => {
    expect(SHORT).toMatch(/export async function GET\(/);
  });

  it('клик считается и записывается событием', () => {
    expect(SHORT).toMatch(/SET clicks = COALESCE\(clicks, 0\) \+ 1/);
    expect(SHORT).toMatch(/INSERT INTO agent_referral_events \(link_id, event_type\) VALUES \(\$1, 'click'\)/);
  });

  it('форма кода проверяется ДО базы', () => {
    const check = SHORT.indexOf('isAgentReferralCode(code)');
    const query = SHORT.indexOf('FROM agent_referral_links');
    expect(check).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(check);
  });

  it('неизвестный или погашенный код ничего не пишет и уводит на главную', () => {
    expect(SHORT).toMatch(/is_active = true/);
    expect(SHORT).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
    expect(SHORT).toMatch(/if \(!link\) \{\s*\n\s*return NextResponse\.redirect\(home, 302\)/);
  });

  it('персональных данных ради счётчика не собирается', () => {
    // Колонки ip/user_agent в таблице есть, и соседний счётчик их пишет.
    // Здесь — нет: чтобы посчитать переход, довольно самого перехода.
    expect(SHORT).not.toMatch(/user_agent/);
    expect(SHORT).not.toMatch(/INSERT INTO agent_referral_events[\s\S]{0,120}\bip\b/);
  });

  it('код едет дальше в адресе — иначе память его не поймает', () => {
    expect(SHORT).toMatch(/searchParams\.set\('ref', code\)/);
  });

  it('отказ базы не глушится и человека всё равно уводит', () => {
    expect(SHORT).toMatch(/SQLSTATE/);
    expect(SHORT).toMatch(/console\.error/);
  });
});
