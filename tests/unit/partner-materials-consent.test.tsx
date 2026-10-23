/**
 * Согласие партнёра на использование материалов его сайта (миграция 1321,
 * решение владельца 23.10: «нужна форма согласия об использовании матерьялов
 * сайтов партнеров на нашем сайте»). Судится вызовом и рендером:
 *
 *   · текст один для всех и называет партнёра, сайты, где Ведар использует
 *     материалы и как; обещаний, которых платформа не исполняет («с указанием
 *     источника», «не передаёт третьим лицам», «в выбранных местах»), нет
 *     (ревью 23.10);
 *   · правила ссылки и подписи: форма ключа, срок, «использована», имя и
 *     должность, «текст изменился»;
 *   · согласие подписанта на ПД — свой текст и своя версия (не «туроператору»);
 *   · POST /api/partner-consent: без галочки ПД, без полномочий, без текста —
 *     400 и записи нет; разошёлся текст — 409; устаревшая ссылка — 410
 *     словами; удачная запись — с текстом страницы на сверку и версией
 *     'partner-signer';
 *   · форма: без ключа — правило словами; с ключом — название партнёра и
 *     текст, галочек объёма нет; кнопка неактивна, выглядит неактивной и
 *     связана с причиной; в запрос уходит СОСТОЯНИЕ галочек и показанный текст;
 *   · страница не отдаёт адрес с ключом в Метрику;
 *   · строка «партнёр разрешил …» — на его странице перевозчика и прокатчика
 *     только при записи, на карточках общих витрин — никогда;
 *   · админка: роут (ссылка, отказ базы, отзыв) и панель — рендером во всех
 *     исходах: действует / отозвано (снять материалы) / не было / сбой /
 *     ссылка истекла.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const { dbQuery, grantMock, checkMock, issueMock, loadConsentsMock, loadInviteMock, revokeMock } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  grantMock: vi.fn(),
  checkMock: vi.fn(),
  issueMock: vi.fn(),
  loadConsentsMock: vi.fn(),
  loadInviteMock: vi.fn(),
  revokeMock: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a), transaction: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));
vi.mock('@/lib/partners/material-consent', async (orig) => {
  const real = await orig<typeof import('@/lib/partners/material-consent')>();
  return {
    ...real,
    grantMaterialsConsent: (...a: unknown[]) => grantMock(...a),
    checkConsentInvite: (...a: unknown[]) => checkMock(...a),
    issueConsentInvite: (...a: unknown[]) => issueMock(...a),
    loadPartnerConsents: (...a: unknown[]) => loadConsentsMock(...a),
    loadConsentInvite: (...a: unknown[]) => loadInviteMock(...a),
    revokeMaterialsConsent: (...a: unknown[]) => revokeMock(...a),
  };
});

import {
  PARTNER_MATERIALS_CONSENT_VERSION, authorityStatement, consentDocument, materialsConsentLine, materialsConsentParagraphs,
  siteWords,
} from '@/lib/legal/partner-materials-consent';
import { consentWording, PD_CONSENT_VERSION } from '@/lib/legal/pd-consent';
import {
  consentInviteVerdict, grantProblemText, isConsentKeyShape, normalizeSignerName, normalizeSignerRole, partnerConsentUrl,
} from '@/lib/partners/material-consent-rules';
import { shouldTrackPath } from '@/lib/analytics/metrika';
import { PartnerMaterialsConsentPanel } from '@/components/admin/PartnerMaterialsConsentPanel';
import { parseActiveConsent } from '@/lib/partners/material-consent';
import { POST as submitConsent } from '@/app/api/partner-consent/route';
import { POST as checkInviteRoute } from '@/app/api/partner-consent/invite/route';
import { GET as adminGet, POST as adminPost, PATCH as adminPatch } from '@/app/api/admin/partners/[id]/material-consent/route';
import { PartnerConsentForm } from '@/components/partners/PartnerConsentForm';
import { CarrierPage } from '@/components/transfers/CarrierPage';
import { CharterCard } from '@/components/transfers/CharterCard';
import { RentalCompanyPage } from '@/components/rental/RentalCompanyPage';
import { RentalCompanyCard } from '@/components/rental/RentalCompanyCard';
import { OperatorLegalInfo } from '@/components/operator/OperatorLegalInfo';
import type { CarrierProfile } from '@/lib/transfers/charter-format';
import type { RentalCompanyProfile } from '@/lib/rental/rental-format';

const KEY = 'A'.repeat(16) + 'b_-'.repeat(5) + 'c';
const PARTNER_ID = '11111111-2222-4333-8444-555555555555';
const jsonReq = (url: string, body: unknown, method = 'POST') =>
  new Request(url, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, body: JSON.stringify(body) }) as never;

beforeEach(() => {
  for (const m of [dbQuery, grantMock, checkMock, issueMock, loadConsentsMock, loadInviteMock, revokeMock]) m.mockReset();
});
afterEach(() => { cleanup(); window.location.hash = ''; vi.unstubAllGlobals(); });

const LAGUNA = { partnerName: 'Лагуна Прокат', sites: ['https://лагунапрокат.рф/'] };

describe('текст согласия', () => {
  it('называет партнёра, сайты, где и как Ведар использует материалы, отзыв', () => {
    expect(KEY).toHaveLength(32);
    const text = materialsConsentParagraphs(LAGUNA).join('\n');
    expect(text).toContain('«Лагуна Прокат» разрешает Ведару (vedarai.ru)');
    expect(text).toContain('лагунапрокат.рф');
    expect(text).toContain('фотографии, видео, логотип');
    expect(text).toContain('со своих сайтов и страниц (лагунапрокат.рф)');
    expect(text).toMatch(/Где Ведар их показывает: на странице партнёра/);
    expect(text).toMatch(/языковые модели, в том числе зарубежные/);
    expect(text).toMatch(/не даёт ему места выше/);
    expect(text).toMatch(/Отозвать можно/);
    expect(authorityStatement('Лагуна Прокат')).toContain('от имени «Лагуна Прокат»');
    expect(PARTNER_MATERIALS_CONSENT_VERSION).toBe('2026-10-23');
  });

  it('называет то, что перепись путей 23.10 нашла в коде: получателей, хранение, изменения, чтение сайта', () => {
    const text = consentDocument(LAGUNA);
    for (const fact of [
      /турагенты/, /площадки объявлений — через открытые выгрузки/, /собирают данные для обучения моделей/,
      /сервисы веб-аналитики/, /открытом репозитории кода Ведара на GitHub \(США\)/, /хранилище Timeweb \(Россия\)/,
      /пересказывать и дополнять своими словами/, /на экране может подкрашивать/, /цену — показывать словом «от»/,
      /Раз в сутки Ведар читает главную страницу сайта партнёра/, /озвучивает ответы/, /английском/,
      /размещённые партнёром на сторонних площадках/, /вручную снимает с показа/, /Ведар удалить не может/,
    ]) {
      expect(text, String(fact)).toMatch(fact);
    }
  });

  it('обещаний, которых платформа не исполняет, в тексте нет (ревью 23.10)', () => {
    const text = consentDocument(LAGUNA);
    // Источник называют не все поверхности; передача площадкам и агентам есть
    // по построению; выбора мест показа нет.
    for (const promise of [/указани[ея]м? источника/i, /третьим лицам/i, /выбранн/i, /не меняет/i]) {
      expect(text).not.toMatch(promise);
    }
  });

  it('документ — абзацы и подтверждение полномочий; без сайтов — без пустых скобок', () => {
    const doc = consentDocument(LAGUNA);
    expect(doc.split('\n\n')).toEqual([...materialsConsentParagraphs(LAGUNA), authorityStatement('Лагуна Прокат')]);
    expect(consentDocument({ partnerName: 'Без сайта', sites: [] })).not.toContain('()');
  });

  it('строка на странице партнёра — факт записи, а не происхождение показанного', () => {
    expect(materialsConsentLine({ grantedOn: '2026-10-23', sites: ['https://лагунапрокат.рф/'] }))
      .toBe('Партнёр разрешил Ведару показывать материалы своего сайта лагунапрокат.рф: согласие от 23.10.2026.');
    expect(materialsConsentLine({ grantedOn: '2026-10-23', sites: [] }))
      .toBe('Партнёр разрешил Ведару показывать материалы своих сайтов: согласие от 23.10.2026.');
    expect(materialsConsentLine({ grantedOn: '2026-10-23', sites: ['https://a.test', 'https://b.test/'] }))
      .toBe('Партнёр разрешил Ведару показывать материалы своих сайтов a.test, b.test: согласие от 23.10.2026.');
    expect(siteWords('https://example.test/')).toBe('example.test');
  });

  it('согласие подписанта на ПД — свой текст и своя версия, не «туроператору»', () => {
    const w = consentWording('partner-signer');
    expect(w.version).toBe('2026-10-23-partner-signer');
    expect(w.version).not.toBe(PD_CONSENT_VERSION);
    expect(w.text).toMatch(/учёта согласия партнёра/);
    expect(w.text).not.toMatch(/туроператору/);
  });

  it('страница согласия не отдаёт адрес с ключом в Метрику', () => {
    expect(shouldTrackPath('/partner-consent')).toBe(false);
  });
});

describe('правила ссылки и подписи', () => {
  it('ключ, адрес, срок и «использована»', () => {
    expect(isConsentKeyShape(KEY)).toBe(true);
    expect(isConsentKeyShape('короткий')).toBe(false);
    expect(partnerConsentUrl('https://vedarai.ru/', KEY)).toBe(`https://vedarai.ru/partner-consent#${KEY}`);
    const now = Date.parse('2026-10-23T00:00:00Z');
    expect(consentInviteVerdict({ expiresAt: '2026-11-22T00:00:00Z', usedAt: null }, now)).toEqual({ ok: true });
    expect(consentInviteVerdict({ expiresAt: '2026-10-22T00:00:00Z', usedAt: null }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(consentInviteVerdict({ expiresAt: '2026-11-22T00:00:00Z', usedAt: '2026-10-23' }, now)).toEqual({ ok: false, reason: 'used' });
  });

  it('«текст изменился» — своими словами, остальное — как у ссылки', () => {
    expect(grantProblemText('text_changed')).toMatch(/Обновите страницу/);
    expect(grantProblemText('expired')).toMatch(/Срок ссылки истёк/);
  });

  it('имя — буквами; должность — свободным текстом без управляющих знаков', () => {
    expect(normalizeSignerName('  Анна   Петрова ')).toBe('Анна Петрова');
    expect(normalizeSignerName('A')).toBeNull();
    expect(normalizeSignerName('<script>')).toBeNull();
    expect(normalizeSignerRole('ИП, владелец')).toBe('ИП, владелец');
    expect(normalizeSignerRole('a\u0007b')).toBeNull();
  });

  it('разбор действующего согласия: мусор — «записи нет», а не выдумка', () => {
    expect(parseActiveConsent(null)).toBeNull();
    expect(parseActiveConsent({ grantedOn: 1 })).toBeNull();
    expect(parseActiveConsent({ grantedOn: '2026-10-23', sites: 'не массив' })).toBeNull();
    expect(parseActiveConsent({ grantedOn: '2026-10-23', sites: ['https://a.test'] }))
      .toEqual({ grantedOn: '2026-10-23', sites: ['https://a.test'] });
  });
});

describe('POST /api/partner-consent', () => {
  const good = {
    key: KEY, signer_name: 'Анна Петрова', signer_role: 'владелец', text: consentDocument(LAGUNA),
    authority: true, pd_consent: true,
  };

  it('без согласия на ПД, без полномочий, без текста, без имени — 400, записи нет', async () => {
    const { text: _omit, ...noText } = good;
    void _omit;
    for (const bad of [{ ...good, pd_consent: false }, { ...good, authority: false }, noText, { ...good, signer_name: '1' }]) {
      const res = await submitConsent(jsonReq('http://x/api/partner-consent', bad));
      expect(res.status).toBe(400);
    }
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('удачно — текст страницы уходит на сверку, согласие подписанта своей версии', async () => {
    grantMock.mockResolvedValue({ ok: true, grantedOn: '2026-10-23', partnerName: 'Лагуна Прокат' });
    const res = await submitConsent(jsonReq('http://x/api/partner-consent', good));
    expect(res.status).toBe(200);
    const arg = grantMock.mock.calls[0]![0] as { shownText: string; signerName: string; pd: { version: string; ip: string; source: string } };
    expect(arg.shownText).toBe(consentDocument(LAGUNA));
    expect(arg.signerName).toBe('Анна Петрова');
    expect(arg.pd.version).toBe('2026-10-23-partner-signer');
    expect(arg.pd.source).toBe('partner-consent-page');
  });

  it('текст разошёлся с серверным — 409 «обновите страницу»', async () => {
    grantMock.mockResolvedValueOnce({ ok: false, reason: 'text_changed' });
    const res = await submitConsent(jsonReq('http://x/api/partner-consent', good));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/Обновите страницу/);
  });

  it('ссылка устарела или использована — 410 словами; не найдена — 404; отказ базы — 503', async () => {
    grantMock.mockResolvedValueOnce({ ok: false, reason: 'used' });
    const used = await submitConsent(jsonReq('http://x/api/partner-consent', good));
    expect(used.status).toBe(410);
    expect((await used.json() as { error: string }).error).toMatch(/уже записано/);
    grantMock.mockResolvedValueOnce({ ok: false, reason: 'unknown' });
    expect((await submitConsent(jsonReq('http://x/api/partner-consent', good))).status).toBe(404);
    grantMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await submitConsent(jsonReq('http://x/api/partner-consent', good))).status).toBe(503);
    expect(String(err.mock.calls[0]?.[0])).toContain('sqlstate=57P01');
    err.mockRestore();
  });

  it('проверка ключа отдаёт партнёра и сайты, а по плохой ссылке — объяснение', async () => {
    checkMock.mockResolvedValueOnce({ state: 'ok', partnerName: 'Лагуна Прокат', sites: ['https://лагунапрокат.рф/'], current: null });
    const ok = await checkInviteRoute(jsonReq('http://x/api/partner-consent/invite', { key: KEY }));
    expect(await ok.json()).toMatchObject({ success: true, data: { state: 'ok', partner_name: 'Лагуна Прокат' } });
    checkMock.mockResolvedValueOnce({ state: 'expired' });
    const exp = await checkInviteRoute(jsonReq('http://x/api/partner-consent/invite', { key: KEY }));
    expect(await exp.json()).toMatchObject({ data: { state: 'expired', message: expect.stringMatching(/Срок ссылки истёк/) } });
  });
});

describe('страница /partner-consent: форма', () => {
  it('без ключа — правило словами, формы нет', async () => {
    render(<PartnerConsentForm />);
    expect(await screen.findByTestId('consent-no-link')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Подписать/ })).toBeNull();
  });

  it('с ключом — партнёр и текст без галочек объёма; кнопка неактивна, выглядит неактивной и связана с причиной; в запрос уходят состояние галочек и показанный текст', async () => {
    window.location.hash = `#${KEY}`;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/partner-consent/invite') {
        return new Response(JSON.stringify({ success: true, data: { state: 'ok', partner_name: 'Лагуна Прокат', sites: ['https://лагунапрокат.рф/'], current: null } }));
      }
      return new Response(JSON.stringify({ success: true, data: { granted_on: '2026-10-23', partner_name: 'Лагуна Прокат' }, echo: init?.body }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PartnerConsentForm />);
    expect(await screen.findByRole('heading', { name: 'Лагуна Прокат' })).toBeTruthy();
    expect(screen.getByText(/разрешает Ведару \(vedarai\.ru\)/)).toBeTruthy();
    // Галочек объёма нет: их нечем исполнить. Галочки две — полномочия и ПД.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByText(/Где Ведар может их показывать/)).toBeNull();

    const button = screen.getByRole('button', { name: 'Подписать согласие' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toMatch(/disabled:opacity-50/);
    const why = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toMatch(/Чтобы подписать, осталось:.*согласие на обработку имени и должности/);

    fireEvent.change(screen.getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(screen.getByLabelText('Должность или кем вы приходитесь партнёру'), { target: { value: 'владелец' } });
    fireEvent.click(screen.getByLabelText(/Подтверждаю, что вправе/));
    fireEvent.click(screen.getByLabelText(/учёта согласия партнёра/));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const sent = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ key: KEY, authority: true, pd_consent: true, signer_name: 'Анна Петрова', text: consentDocument(LAGUNA) });
    expect(sent).not.toHaveProperty('materials');
    expect(sent).not.toHaveProperty('surfaces');
    const done = await screen.findByRole('status');
    expect(done.textContent).toMatch(/согласие записано 23\.10\.2026/);
    expect(done.textContent).not.toMatch(/выбранных/);
  });
});

describe('строка «партнёр разрешил» — только на его странице и только при записи', () => {
  const consent = { grantedOn: '2026-10-23', sites: ['https://лагунапрокат.рф/'] };
  const CARRIER: CarrierProfile = {
    partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null,
    description: null, verified: false, vehicles: [], seatClasses: [], destinations: [], extraDay: null, rates: [],
    photos: [], clips: [], legal: null, video: null, license: null, passengerInsurance: null,
    phone: null, telegramHref: null, whatsappHref: null,
  };
  const DATA = { safety: { state: 'ok' as const, byPlace: {} }, reviews: { state: 'ok' as const, items: [], count: 0, average: null }, rental: { state: 'ok' as const, has: false } };
  const COMPANY: RentalCompanyProfile = {
    partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null, photos: [], offers: [],
    phone: null, telegramHref: null, description: null, verified: false, legal: null, terms: null, alsoCarrier: false,
  };
  const LINE = 'Партнёр разрешил Ведару показывать материалы своего сайта лагунапрокат.рф: согласие от 23.10.2026.';

  it('страница перевозчика: строка в блоке «Перевозчик» при записи; без записи — нет', () => {
    const a = render(<CarrierPage data={{ ...DATA, carrier: { ...CARRIER, materialsConsent: consent } }} />);
    const line = screen.getByTestId('materials-consent');
    expect(line.textContent).toBe(LINE);
    expect(line.closest('[aria-labelledby="carrier-who"]')).not.toBeNull();
    a.unmount();
    render(<CarrierPage data={{ ...DATA, carrier: { ...CARRIER, materialsConsent: null } }} />);
    expect(screen.queryByTestId('materials-consent')).toBeNull();
  });

  it('страница прокатчика: то же в блоке «Прокатчик»', () => {
    const a = render(<RentalCompanyPage data={{ company: { ...COMPANY, materialsConsent: consent } }} />);
    const line = screen.getByTestId('materials-consent');
    expect(line.textContent).toBe(LINE);
    expect(line.closest('[aria-labelledby="rental-who"]')).not.toBeNull();
    a.unmount();
    render(<RentalCompanyPage data={{ company: COMPANY }} />);
    expect(screen.queryByTestId('materials-consent')).toBeNull();
  });

  it('страница туроператора: строка в «Юридической информации» при записи; без записи — нет, и пустого блока тоже', () => {
    const a = render(<OperatorLegalInfo legal={null} registryNumber={null} registryStatus={null} registryCheckedAt={null} materialsConsent={consent} />);
    expect(screen.getByTestId('materials-consent').textContent).toBe(LINE);
    a.unmount();
    const b = render(<OperatorLegalInfo legal={null} registryNumber={null} registryStatus={null} registryCheckedAt={null} materialsConsent={null} />);
    expect(b.container.textContent).toBe('');
  });

  it('карточки общих витрин строки не несут никогда', () => {
    const a = render(<CharterCard carrier={CARRIER} />);
    expect(a.container.textContent).not.toMatch(/разрешил Ведару|согласие от/);
    a.unmount();
    const b = render(<RentalCompanyCard company={COMPANY} />);
    expect(b.container.textContent).not.toMatch(/разрешил Ведару|согласие от/);
  });
});

describe('админский роут согласия', () => {
  const ctx = { params: Promise.resolve({ id: PARTNER_ID }) };

  it('ссылка: ключ во фрагменте и текст для пересылки; ключ показывается один раз', async () => {
    issueMock.mockResolvedValue({ ok: true, key: KEY, expiresAt: '2026-11-22T00:00:00.000Z', partnerName: 'Лагуна Прокат' });
    const res = await adminPost(new Request(`http://x/api/admin/partners/${PARTNER_ID}/material-consent`, { method: 'POST' }) as never, ctx);
    const body = await res.json() as { data: { url: string; text: string; shown_once: boolean } };
    expect(body.data.url).toMatch(new RegExp(`/partner-consent#${KEY}$`));
    expect(body.data.text).toContain(body.data.url);
    expect(body.data.text).toContain('«Лагуна Прокат»');
    expect(body.data.shown_once).toBe(true);
  });

  it('отказ базы — 503 «не значит, что согласия нет»; кривой id — 400', async () => {
    loadConsentsMock.mockRejectedValue(Object.assign(new Error('down'), { code: '08006' }));
    loadInviteMock.mockResolvedValue(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await adminGet(new Request('http://x') as never, ctx);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/не значит, что согласия нет/);
    err.mockRestore();
    const bad = await adminGet(new Request('http://x') as never, { params: Promise.resolve({ id: 'new' }) });
    expect(bad.status).toBe(400);
  });

  it('отзыв — с причиной не короче 8 знаков; нечего отзывать — 409', async () => {
    expect((await adminPatch(jsonReq('http://x', { reason: 'коротко' }, 'PATCH'), ctx)).status).toBe(400);
    revokeMock.mockResolvedValueOnce({ ok: false, reason: 'nothing_active' });
    expect((await adminPatch(jsonReq('http://x', { reason: 'Написал в MAX 25.10: снять фото' }, 'PATCH'), ctx)).status).toBe(409);
    revokeMock.mockResolvedValueOnce({ ok: true, revoked: 1 });
    expect((await adminPatch(jsonReq('http://x', { reason: 'Написал в MAX 25.10: снять фото' }, 'PATCH'), ctx)).status).toBe(200);
    expect(revokeMock).toHaveBeenLastCalledWith(PARTNER_ID, 'Написал в MAX 25.10: снять фото');
  });
});

describe('панель согласия в админке — рендером во всех исходах', () => {
  const base = {
    id: '1', grantedOn: '2026-10-23', textVersion: '2026-10-23', signedText: consentDocument(LAGUNA),
    sites: ['https://лагунапрокат.рф/'], signerName: 'Анна Петрова', signerRole: 'владелец',
    revokedAt: null, revokedOn: null, revokeReason: null,
  };
  const serve = (data: unknown, ok = true) => vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(ok ? { success: true, data } : { success: false, error: 'Не смогли прочитать согласия партнёра — сбой базы. Это не значит, что согласия нет.' }),
      { status: ok ? 200 : 503 })));

  it('действует: кто подписал, сайты и сам текст; отозвать можно', async () => {
    serve({ consents: [base], invite: { issuedOn: '2026-10-23', expiresOn: '2026-11-22', state: 'used' } });
    render(<PartnerMaterialsConsentPanel partnerId={PARTNER_ID} />);
    expect((await screen.findByTestId('consent-badge')).textContent).toBe('действует с 23.10.2026');
    const box = screen.getByTestId('consent-active');
    expect(box.textContent).toMatch(/Анна Петрова, владелец/);
    expect(box.textContent).toMatch(/лагунапрокат\.рф/);
    expect(box.textContent).toContain('«Лагуна Прокат» разрешает Ведару');
    expect(screen.getByRole('button', { name: /Отозвать/ })).toBeTruthy();
  });

  it('отозвано: дата и чьи слова, и что сделать — снять материалы; звать подписать снова не предлагает', async () => {
    serve({
      consents: [{ ...base, revokedAt: '2026-10-25 01:00:00+00', revokedOn: '2026-10-25', revokeReason: 'Написал в MAX 25.10: снять фото' }],
      invite: null,
    });
    render(<PartnerMaterialsConsentPanel partnerId={PARTNER_ID} />);
    expect((await screen.findByTestId('consent-badge')).textContent).toBe('отозвано 25.10.2026');
    const box = screen.getByTestId('consent-revoked');
    expect(box.textContent).toMatch(/отозвано 25\.10\.2026: Написал в MAX 25\.10: снять фото/);
    expect(box.textContent).toMatch(/Снимите с показа материалы, взятые с сайта партнёра/);
    expect(screen.queryByText(/пошлите ему ссылку/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Отозвать/ })).toBeNull();
  });

  it('не было: прямо так и сказано', async () => {
    serve({ consents: [], invite: null });
    render(<PartnerMaterialsConsentPanel partnerId={PARTNER_ID} />);
    expect((await screen.findByTestId('consent-badge')).textContent).toBe('не было');
    expect(screen.getByTestId('consent-never').textContent).toMatch(/Согласие не записано/);
  });

  it('просроченная ссылка — «истекла», а не «действует до»', async () => {
    serve({ consents: [], invite: { issuedOn: '2026-09-01', expiresOn: '2026-10-01', state: 'expired' } });
    render(<PartnerMaterialsConsentPanel partnerId={PARTNER_ID} />);
    const line = await screen.findByTestId('consent-invite');
    expect(line.textContent).toMatch(/истекла 01\.10\.2026/);
    expect(line.textContent).not.toMatch(/действует до/);
  });

  it('сбой чтения — словами, без значка «не было»', async () => {
    serve(null, false);
    render(<PartnerMaterialsConsentPanel partnerId={PARTNER_ID} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/не значит, что согласия нет/);
    expect(screen.queryByTestId('consent-badge')).toBeNull();
  });
});
