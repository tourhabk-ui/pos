// @vitest-environment jsdom
/**
 * Оферта для партнёров: отметка на регистрации, журнал акцепта, дверь кабинета
 * (план готовности 23.11, этап 5).
 *
 * Оферта (п. 2) называет отметку о согласии частью акцепта, а на формах её не
 * было, и принял ли партнёр условия и какую редакцию — не было записано нигде.
 *
 * Судится рендером форм и вызовом дверей. Текст оферты этим этапом не
 * меняется: сторож держит связку «файл оферты — версия в журнале».
 */
import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  partner: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: vi.fn(), completeMfaSignIn: vi.fn() }),
  MfaRequiredError: class extends Error {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/app/auth/login/_TelegramLoginButton', () => ({ default: () => null }));
vi.mock('@/app/auth/login/_MaxLoginButton', () => ({ default: () => null }));
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: h.partner }));
vi.mock('@/lib/legal/offer-acceptance', async (orig) => ({
  ...(await orig<typeof import('@/lib/legal/offer-acceptance')>()),
  recordOfferAcceptanceForPartner: h.record,
}));

import AuthPageClient from '@/app/auth/login/_AuthPageClient';
import JoinClient from '@/app/operators/join/_JoinClient';
import OfferPage from '@/app/legal/offer/page';
import { OfferAcceptCheckbox } from '@/components/legal/OfferAcceptCheckbox';
import {
  LEGAL_PENDING, OFFER_EDITION, OFFER_REQUIRED_TEXT, OFFER_ROLES, OFFER_URL, OFFER_VERSION,
  isOfferRole, offerRequiredFor,
} from '@/lib/legal/offer';
import { REQUEST_RECEIVING_CATEGORIES } from '@/lib/partners/categories';
import { partnerRegisterPath } from '@/lib/auth/register-link';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  h.partner.mockReset();
  h.record.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const offerBox = () => screen.queryByRole('checkbox', { name: /Принимаю условия оферты для партнёров/ }) as HTMLInputElement | null;

// ─── Версия и текст оферты ────────────────────────────────────────────────────

describe('версия оферты привязана к её тексту', () => {
  it('редакция на странице оферты — та, что названа в журнале акцепта', () => {
    render(<OfferPage />);
    expect(screen.getByText(`Редакция от ${OFFER_EDITION}`)).toBeTruthy();
    // Версия — та же дата цифрами.
    expect(OFFER_VERSION).toBe('2026-10-05');
    expect(OFFER_EDITION).toBe('5 октября 2026 г.');
  });

  it('файл оферты не менялся без смены версии: отпечаток заморожен рядом с версией', () => {
    // Меняется текст оферты — меняется OFFER_VERSION и OFFER_EDITION (lib/legal/offer.ts),
    // и только вместе с ними этот отпечаток. Иначе журнал назовёт редакцию,
    // которой партнёр не видел.
    const FROZEN: Record<string, string> = {
      '2026-10-05': 'b2138f52bdedfb9f45660d7eee393532adc5cd37ae4dde8e31d80271b9706b28',
    };
    const now = createHash('sha256').update(readFileSync(join(ROOT, 'app/legal/offer/page.tsx'))).digest('hex');
    expect(FROZEN[OFFER_VERSION], 'для действующей версии оферты отпечаток не записан').toBeDefined();
    expect(now, 'текст оферты изменён — нужна новая версия и редакция в lib/legal/offer.ts').toBe(FROZEN[OFFER_VERSION]);
  });

  it('стороны оферты — роли с заявками; агент и турист — нет', () => {
    expect([...OFFER_ROLES]).toEqual([...REQUEST_RECEIVING_CATEGORIES]);
    for (const role of ['operator', 'guide', 'transfer', 'stay', 'gear', 'cars']) expect(isOfferRole(role), role).toBe(true);
    for (const role of ['agent', 'tourist', 'admin', '', null, undefined]) expect(isOfferRole(role), String(role)).toBe(false);
    expect(offerRequiredFor(['tourist'])).toBe(false);
    expect(offerRequiredFor(['agent'])).toBe(false);
    expect(offerRequiredFor([])).toBe(false);
    expect(offerRequiredFor(['agent', 'gear'])).toBe(true);
  });

  it('пометки о нерешённом не обещают условий: ни сроков, ни ставок, ни текста договора', () => {
    for (const text of Object.values(LEGAL_PENDING)) {
      expect(text).toContain('ждёт решения владельца платформы и юриста');
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/комисси|тариф|бесплатн|выплат|налог|чек|НПД/i);
    }
  });
});

// ─── Отметка ──────────────────────────────────────────────────────────────────

describe('отметка «принимаю оферту»', () => {
  it('ссылка ведёт на оферту в новой вкладке; нажатие отдаёт состояние, а не «да»', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OfferAcceptCheckbox checked={false} onChange={onChange} />);
    const link = screen.getByRole('link', { name: 'оферты для партнёров' });
    expect(link.getAttribute('href')).toBe(OFFER_URL);
    expect(OFFER_URL).toBe('/legal/offer');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(offerBox()?.checked).toBe(false);
    fireEvent.click(offerBox()!);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<OfferAcceptCheckbox checked onChange={onChange} />);
    expect(offerBox()?.checked).toBe(true);
    fireEvent.click(offerBox()!);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

// ─── Общая форма регистрации ──────────────────────────────────────────────────

describe('форма регистрации /auth/login', () => {
  const openForm = (url: string) => {
    window.history.replaceState(null, '', url);
    render(<AuthPageClient />);
  };
  const fill = () => {
    fireEvent.change(document.getElementById('reg-name')!, { target: { value: 'Тест' } });
    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'test@example.com' } });
    fireEvent.change(document.getElementById('reg-password')!, { target: { value: 'Vulkan2026x' } });
    fireEvent.change(document.getElementById('reg-password-confirm')!, { target: { value: 'Vulkan2026x' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/ }));
  };
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));

  it('туристу отметки об оферте нет, и в запросе её нет', async () => {
    openForm('/auth/login?mode=register');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Зарегистрироваться' })).toBeTruthy());
    expect(offerBox()).toBeNull();
    fill();
    fetchMock.mockResolvedValue(ok({ success: true, user: { id: '1' }, token: 't' }));
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty('offer_accepted');
    expect(sentBody().role).toBe('tourist');
  });

  it.each(REQUEST_RECEIVING_CATEGORIES.map((r) => [r]))('партнёр «%s»: отметка есть; без неё форма не уходит и говорит почему', async (role) => {
    openForm(partnerRegisterPath(role));
    await waitFor(() => expect(offerBox()).not.toBeNull());
    expect(offerBox()?.checked).toBe(false);
    fill();
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('register-error').textContent).toBe(OFFER_REQUIRED_TEXT);
  });

  it('партнёр отметил оферту: в запрос уходит состояние отметки', async () => {
    openForm(partnerRegisterPath('stay'));
    await waitFor(() => expect(offerBox()).not.toBeNull());
    fill();
    fireEvent.click(offerBox()!);
    fetchMock.mockResolvedValue(ok({ success: true, user: { id: '1' }, token: 't' }));
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/register');
    expect(sentBody()).toMatchObject({ role: 'stay', roles: ['stay'], offer_accepted: true, pd_consent: true });
  });

  it('снял отметку — форма снова не уходит: согласие на данные оферту не заменяет', async () => {
    openForm(partnerRegisterPath('guide'));
    await waitFor(() => expect(offerBox()).not.toBeNull());
    fill();
    fireEvent.click(offerBox()!);
    fireEvent.click(offerBox()!);
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('register-error').textContent).toBe(OFFER_REQUIRED_TEXT);
  });

  it('отказ сервера «примите оферту» показан его словами', async () => {
    openForm(partnerRegisterPath('gear'));
    await waitFor(() => expect(offerBox()).not.toBeNull());
    fill();
    fireEvent.click(offerBox()!);
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: OFFER_REQUIRED_TEXT, code: 'offer_required' }) });
    submit();
    await waitFor(() => expect(screen.getByTestId('register-error').textContent).toBe(OFFER_REQUIRED_TEXT));
  });
});

// ─── Форма туроператора /operators/join ───────────────────────────────────────

describe('форма туроператора /operators/join', () => {
  const fill = () => {
    fireEvent.change(screen.getByPlaceholderText('Камчатская рыбалка — Иван Петров'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByPlaceholderText('operator@example.com'), { target: { value: 'test@example.com' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'Vulkan2026x' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/ }));
  };
  const submit = () => fireEvent.submit(document.querySelector('form')!);

  it('без отметки об оферте форма не уходит и говорит почему', () => {
    render(<JoinClient routesLine={null} />);
    expect(offerBox()?.checked).toBe(false);
    fill();
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(OFFER_REQUIRED_TEXT)).toBeTruthy();
  });

  it('с отметкой — в запрос уходит её состояние', async () => {
    render(<JoinClient routesLine={null} />);
    fill();
    fireEvent.click(offerBox()!);
    fetchMock.mockResolvedValue(ok({ success: true, user: { id: '1', role: 'operator' }, token: 't' }));
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/register');
    expect(sentBody()).toMatchObject({ role: 'operator', roles: ['operator'], offer_accepted: true, pd_consent: true });
  });
});

// ─── Дверь кабинета ───────────────────────────────────────────────────────────

describe('POST /api/hub/partner/offer — принять оферту из кабинета', () => {
  const PARTNER = 'c5000000-0000-4000-8000-000000000001';
  const USER = 'c5000000-0000-4000-8000-000000000002';
  const ctx = (over: Record<string, unknown> = {}) => ({ partnerId: PARTNER, userId: USER, category: 'operator', seat: 'owner', ...over });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/hub/partner/offer/route');
    const res = await POST(new NextRequest('http://localhost/api/hub/partner/offer', {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };

  it('владелец кабинета принимает: запись — своей карточке и своему входу, версию называет ответ', async () => {
    h.partner.mockResolvedValue(ctx());
    h.record.mockResolvedValue('recorded');
    const r = await post({ offer_accepted: true });
    expect(r).toEqual({ status: 200, body: { success: true, data: { version: OFFER_VERSION } } });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][0]).toMatchObject({ partnerId: PARTNER, userId: USER });
  });

  it('карточку из запроса дверь не берёт: чужой id в теле ничего не меняет', async () => {
    h.partner.mockResolvedValue(ctx());
    h.record.mockResolvedValue('recorded');
    await post({ offer_accepted: true, partnerId: 'c5000000-0000-4000-8000-0000000000ff', partner_id: 'x', userId: 'y' });
    expect(h.record.mock.calls[0][0]).toMatchObject({ partnerId: PARTNER, userId: USER });
  });

  it.each(REQUEST_RECEIVING_CATEGORIES.map((r) => [r]))('роль «%s» — сторона оферты: дверь принимает', async (category) => {
    h.partner.mockResolvedValue(ctx({ category }));
    h.record.mockResolvedValue('recorded');
    expect((await post({ offer_accepted: true })).status).toBe(200);
  });

  it('агенту оферта не нужна — 400, записи нет', async () => {
    h.partner.mockResolvedValue(ctx({ category: 'agent' }));
    const r = await post({ offer_accepted: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Вашей роли оферта для партнёров не нужна');
    expect(h.record).not.toHaveBeenCalled();
  });

  it('менеджер команды за компанию оферту не принимает — 403, записи нет', async () => {
    h.partner.mockResolvedValue(ctx({ seat: 'manager' }));
    const r = await post({ offer_accepted: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Принять оферту может владелец кабинета');
    expect(h.record).not.toHaveBeenCalled();
  });

  it('без отметки записи нет: false, строка «true», пустое тело, не JSON — 400', async () => {
    h.partner.mockResolvedValue(ctx());
    for (const body of [{ offer_accepted: false }, { offer_accepted: 'true' }, { offer_accepted: 1 }, {}, null, 'не json']) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toMatchObject({ success: false, error: OFFER_REQUIRED_TEXT, code: 'offer_required' });
    }
    expect(h.record).not.toHaveBeenCalled();
  });

  it('база не записала — 503 и слова, а не «принято»', async () => {
    h.partner.mockResolvedValue(ctx());
    h.record.mockResolvedValue('db_error');
    const r = await post({ offer_accepted: true });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: 'Отметка не записана — попробуйте позже' });
  });

  it('не вошёл — ответ входа, записи нет', async () => {
    h.partner.mockResolvedValue(NextResponse.json({ error: 'Требуется вход' }, { status: 401 }));
    expect((await post({ offer_accepted: true })).status).toBe(401);
    expect(h.record).not.toHaveBeenCalled();
  });
});

// ─── Журнал: запись и чтение ──────────────────────────────────────────────────

describe('журнал акцепта: версия ставится здесь, чтение знает «не прочитано»', () => {
  const load = () => vi.importActual<typeof import('@/lib/legal/offer-acceptance')>('@/lib/legal/offer-acceptance');
  const fakeDb = (impl: (sql: string, params: unknown[]) => unknown) => {
    const query = vi.fn(async (sql: string, params: unknown[]) => impl(sql, params));
    return { db: { query } as unknown as import('pg').PoolClient, query };
  };

  it('запись при регистрации несёт действующую версию и роли-стороны оферты; ноль строк — ноль', async () => {
    const { recordOfferAcceptanceForUser } = await load();
    const { db, query } = fakeDb(() => ({ rowCount: 2 }));
    expect(await recordOfferAcceptanceForUser(db, { userId: 'u1', ip: ' 203.0.113.7 ', source: 'registration' })).toBe(2);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO partner_offer_acceptances');
    expect(params).toEqual(['u1', OFFER_VERSION, '203.0.113.7', 'registration', [...OFFER_ROLES]]);
    const none = fakeDb(() => ({ rowCount: 0 }));
    expect(await recordOfferAcceptanceForUser(none.db, { userId: 'u1', ip: null, source: 'registration' })).toBe(0);
    expect(none.query.mock.calls[0][1][2]).toBeNull();
  });

  it('запись из кабинета: версия — действующая, адрес обрезан; отказ базы — «не записано» без данных в логе', async () => {
    const { recordOfferAcceptanceForPartner } = await load();
    const good = fakeDb(() => ({ rowCount: 1 }));
    expect(await recordOfferAcceptanceForPartner({ partnerId: 'p1', userId: 'u1', ip: 'a'.repeat(200) }, good.db)).toBe('recorded');
    expect(good.query.mock.calls[0][1]).toEqual(['p1', 'u1', OFFER_VERSION, 'a'.repeat(64)]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = fakeDb(() => { throw Object.assign(new Error('секрет 203.0.113.7'), { code: '23503' }); });
    expect(await recordOfferAcceptanceForPartner({ partnerId: 'p1', userId: 'u1', ip: '203.0.113.7' }, bad.db)).toBe('db_error');
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toContain('23503');
    expect(logged).not.toContain('203.0.113.7');
    err.mockRestore();
  });

  it('чтение: нет строки — «акцепта нет»; прежняя редакция — не действующая; отказ базы — «не прочитано»', async () => {
    const { readOfferAcceptance } = await load();
    expect(await readOfferAcceptance('p1', fakeDb(() => ({ rows: [] })).db)).toBeNull();
    const at = new Date('2026-11-23T10:00:00.000Z');
    expect(await readOfferAcceptance('p1', fakeDb(() => ({ rows: [{ offer_version: OFFER_VERSION, accepted_at: at }] })).db))
      .toEqual({ version: OFFER_VERSION, current: true, acceptedAt: '2026-11-23T10:00:00.000Z' });
    expect(await readOfferAcceptance('p1', fakeDb(() => ({ rows: [{ offer_version: '2025-01-01', accepted_at: at }] })).db))
      .toMatchObject({ version: '2025-01-01', current: false });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await readOfferAcceptance('p1', fakeDb(() => { throw Object.assign(new Error('x'), { code: '42P01' }); }).db)).toBe('unknown');
    expect(err.mock.calls.flat().join(' ')).toContain('42P01');
    err.mockRestore();
  });
});

// ─── Запреты ──────────────────────────────────────────────────────────────────

describe('запреты', () => {
  const SKIP = new Set(['node_modules', '.next', '.git', 'tests', 'docs', 'migrations', 'public', 'media', 'coverage']);
  const sources = (dir = ROOT, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full.slice(ROOT.length + 1));
    }
    return out;
  };
  const touching = sources().filter((f) => read(f).includes('partner_offer_acceptances'));

  it('журнал акцепта пишет один файл; стирание аккаунта снимает только адрес и связь с человеком', () => {
    expect(touching.sort()).toEqual(['lib/account/erase.ts', 'lib/legal/offer-acceptance.ts']);
    const journal = read('lib/legal/offer-acceptance.ts');
    // Журнал только пополняется: строк акцепта никто не правит и не удаляет.
    expect(journal).not.toMatch(/UPDATE\s+partner_offer_acceptances|DELETE\s+FROM\s+partner_offer_acceptances/i);
    const erase = read('lib/account/erase.ts');
    expect(erase).not.toMatch(/DELETE\s+FROM\s+partner_offer_acceptances/i);
    const step = erase.match(/UPDATE\s+partner_offer_acceptances\s+SET([^`'"]+)/i)?.[1] ?? '';
    expect(step).toMatch(/ip\s*=\s*NULL/i);
    expect(step).toMatch(/user_id\s*=\s*NULL/i);
    expect(step).not.toMatch(/offer_version|accepted_at|partner_id\s*=/i);
  });

  it('администратор оферту за партнёра не принимает: его двери журнал не пишут', () => {
    const admin = sources().filter((f) => f.startsWith('app/api/admin/') || f.startsWith('app/hub/admin/'));
    expect(admin.length).toBeGreaterThan(50);
    for (const f of admin) {
      expect(read(f), f).not.toMatch(/recordOfferAcceptance|offer-acceptance/);
    }
  });

  it('миграция журнала: версия обязательна, строки туров и партнёров не трогает, без DROP', () => {
    // Номер миграции назначается при сборке PR — файл ищется по имени таблицы.
    const files = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d+_partner_offer_acceptances\.sql$/.test(f));
    expect(files).toHaveLength(1);
    const sql = read(`migrations/${files[0]}`);
    expect(sql).toMatch(/offer_version\s+varchar\(32\)\s+NOT NULL/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS partner_offer_acceptances/i);
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bINSERT\b|\bBEGIN\b/i);
  });
});
