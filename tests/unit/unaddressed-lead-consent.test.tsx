/**
 * Согласие у заявки без адресата называет настоящих получателей (14.11).
 *
 * Заявку без адресата — подбор тура, планер, главная, «Связаться», сохранённая
 * поездка, окно заявки на маршруте — видят в кабинете компании на витрине, и
 * добивка отдаёт её операторам по очереди. Текст согласия называл одного
 * «туроператора». Теперь у таких форм свой текст и своя версия.
 *
 * Судится:
 *  - текст и версия — вызовом реестра согласий;
 *  - дверь `POST /api/leads` — вызовом: в запись идёт версия ПОКАЗАННОГО текста,
 *    строка от клиента вне словаря — отказ, а не запись;
 *  - четыре формы — рендером: текст у галочки и тело запроса при отправке;
 *  - политика конфиденциальности — рендером страницы: что прочтёт человек;
 *  - каждая форма, отправляющая заявку (их находит код, а не список): форма без
 *    адресата не показывает текст одного туроператора, форма с адресатом не
 *    называет «туроператоров». Планер и сохранённая поездка — тяжёлые экраны,
 *    до формы там долгая дорога; их держит это правило, рендера у них здесь нет.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  query: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/leads/create', () => ({ createLeadDetailed: h.create }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: h.query } }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => null) } }));
vi.mock('@/lib/notifications/lead-notify', () => ({
  notifyOperatorNewLead: vi.fn(async () => undefined),
  notifyPartnerNewLeadPersonally: vi.fn(async () => null),
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({
  leadProcessor: { process: vi.fn(async () => { throw new Error('в тесте разбора нет'); }) },
}));
vi.mock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: async () => null, MCP_ATTRIBUTION: { cookieName: 'vedar_mcp' } }));
vi.mock('@/lib/mcp/request-status', () => ({
  LEAD_FORM_KEY_NAME: 'lead_form',
  issueRequestKey: vi.fn(async () => null),
  requestPageLinks: () => ({}),
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ delivered: true })) }));
vi.mock('@/components/shared/PageShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import {
  consentWording, PD_CONSENT_OPERATORS_TEXT, PD_CONSENT_OPERATORS_VERSION, PD_CONSENT_TEXT, PD_CONSENT_VERSION,
} from '@/lib/legal/pd-consent';
import { POST } from '@/app/api/leads/route';
import RequestClient from '@/app/request/_RequestClient';
import ContactClient from '@/app/contact/_ContactClient';
import LeadModal from '@/components/routes/LeadModal';
import HomeV8Client from '@/app/_home/_HomeV8Client';
import type { HomeV8Data } from '@/app/_home/data';
import PrivacyPage from '@/app/legal/privacy/page';

const ROOT = process.cwd();

let ipSeq = 0;
function post(body: Record<string, unknown>) {
  ipSeq += 1; // у двери лимит 5 заявок в минуту с адреса — каждому вызову свой
  return POST(new NextRequest('https://vedarai.ru/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipSeq}`, 'x-real-ip': `203.0.113.${ipSeq}` },
    body: JSON.stringify(body),
  }));
}
const BASE = { name: 'Тест Тестов', phone: '+79990000000', pd_consent: true };
const recorded = () => h.create.mock.calls.at(-1)?.[0] as { pd_consent: { version: string; source: string } | null; operator_id: string | null };

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ id: 'lead-1', created: true });
  h.query.mockReset().mockResolvedValue({ rows: [] });
  // Канал «заявка пришла» в тесте молчит: он не предмет проверки.
  delete process.env.TELEGRAM_LEADS_CHAT_ID;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('реестр согласий: текст для заявки без адресата', () => {
  it('называет туроператоров-партнёров, а не одного туроператора; версия своя', () => {
    const w = consentWording('operators');
    expect(w).toEqual({ text: PD_CONSENT_OPERATORS_TEXT, version: PD_CONSENT_OPERATORS_VERSION });
    expect(w.text).toContain('передачу туроператорам — партнёрам Ведара');
    expect(w.text).not.toMatch(/туроператору(?![а-я])/);
    expect(w.version).toBe('2026-11-14-operators');
    expect(w.version).not.toBe(PD_CONSENT_VERSION);
  });

  it('прежний текст и его версия не тронуты: записи под ним остаются как были', () => {
    expect(consentWording('operator')).toEqual({ text: PD_CONSENT_TEXT, version: '2026-10-08' });
    expect(PD_CONSENT_TEXT).toContain('передачу туроператору для связи по заявке');
  });

  it('текст не обещает того, чего система не делает: «которые могут выполнить заявку» в нём нет', () => {
    expect(PD_CONSENT_OPERATORS_TEXT).not.toContain('могут выполнить');
  });
});

describe('POST /api/leads: в запись идёт версия показанного текста', () => {
  it('форма назвала «туроператорам» — записана новая версия', async () => {
    const res = await post({ ...BASE, pd_consent_purpose: 'operators' });
    expect(res.status).toBe(201);
    expect(recorded().pd_consent).toMatchObject({ version: PD_CONSENT_OPERATORS_VERSION, source: 'web-form' });
  });

  it('форма не назвала текст (закэширована до правки) — записана прежняя версия', async () => {
    const res = await post({ ...BASE });
    expect(res.status).toBe(201);
    expect(recorded().pd_consent).toMatchObject({ version: PD_CONSENT_VERSION });
  });

  it('форма оператора назвала «туроператору» — прежняя версия и канал виджета', async () => {
    h.query.mockResolvedValue({ rows: [{ id: 'P-1', name: 'Компания', widget_domains: null }] });
    const res = await post({ ...BASE, partner_slug: 'kompaniya', pd_consent_purpose: 'operator' });
    expect(res.status).toBe(201);
    expect(recorded()).toMatchObject({ operator_id: 'P-1', pd_consent: { version: PD_CONSENT_VERSION, source: 'widget' } });
  });

  it('строка вне словаря — отказ 422, заявка не создана', async () => {
    for (const bad of ['stay', 'carrier', 'всем', '', 42, null]) {
      const res = await post({ ...BASE, pd_consent_purpose: bad });
      expect(res.status, String(bad)).toBe(422);
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it('без согласия заявки нет, какой бы текст ни был назван', async () => {
    const res = await post({ name: BASE.name, phone: BASE.phone, pd_consent: false, pd_consent_purpose: 'operators' });
    expect(res.status).toBe(422);
    expect(h.create).not.toHaveBeenCalled();
  });
});

/** Тело последнего запроса формы к двери заявок. */
function captureLeadPosts() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/leads') && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ success: true, id: 'lead-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }));
  return bodies;
}
const consentLabel = (id: string) => document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
const tick = (id: string) => fireEvent.click(document.getElementById(id) as HTMLInputElement);
const type = (el: Element | null, value: string) => fireEvent.change(el as HTMLInputElement, { target: { value } });

describe('формы заявки без адресата: текст у галочки и тело запроса', () => {
  it('«Подобрать тур» (/request)', async () => {
    const bodies = captureLeadPosts();
    const { container } = render(<RequestClient />);
    expect(consentLabel('pd-consent-request')).toContain('туроператорам — партнёрам Ведара');
    const inputs = container.querySelectorAll('input[type="text"], input[type="tel"]');
    type(inputs[0] ?? null, 'Тест Тестов');
    type(container.querySelector('input[type="tel"]'), '+79990000000');
    tick('pd-consent-request');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ pd_consent: true, pd_consent_purpose: 'operators' });
  });

  it('«Связаться» (/contact)', async () => {
    const bodies = captureLeadPosts();
    const { container } = render(<ContactClient />);
    expect(consentLabel('pd-consent-contact')).toContain('туроператорам — партнёрам Ведара');
    type(container.querySelector('input[autocomplete="name"], input[name="name"], input[type="text"]'), 'Тест Тестов');
    type(container.querySelector('input[type="tel"]'), '+79990000000');
    tick('pd-consent-contact');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ pd_consent: true, pd_consent_purpose: 'operators' });
  });

  it('окно заявки на маршруте', async () => {
    const bodies = captureLeadPosts();
    const { container } = render(<LeadModal open onClose={() => undefined} routeId="11111111-1111-4111-8111-111111111111" routeTitle="Вулкан Горелый" />);
    expect(consentLabel('pd-consent-lead-modal')).toContain('туроператорам — партнёрам Ведара');
    type(container.querySelector('input[type="text"]'), 'Тест Тестов');
    type(container.querySelector('input[type="tel"]'), '+79990000000');
    tick('pd-consent-lead-modal');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ pd_consent: true, pd_consent_purpose: 'operators', route_title: 'Вулкан Горелый' });
  });

  it('главная', async () => {
    const bodies = captureLeadPosts();
    const DATA: HomeV8Data = {
      safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
      seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
      radar: { hazards: [], center: { lat: 53.04, lng: 158.65, label: 'Петропавловск-Камчатский' } },
      zones: { open: 0, total: 0, updatedAt: null },
      plates: [], transfer: null, stay: null, explore: [], feed: [], stats: [], elements: [],
    };
    render(<HomeV8Client data={DATA} weather={{ kind: 'failed' }} />);
    expect(consentLabel('pd-consent-home')).toContain('туроператорам — партнёрам Ведара');
    type(document.getElementById('lead-name'), 'Тест Тестов');
    type(document.getElementById('lead-phone'), '+79990000000');
    tick('pd-consent-home');
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ pd_consent: true, pd_consent_purpose: 'operators' });
  });
});

describe('политика конфиденциальности говорит о заявке без названного исполнителя', () => {
  it('называет, что её видят туроператоры на витрине и что она может уйти нескольким; редакция — от дня правки', () => {
    const { container } = render(<PrivacyPage />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Заявку, в которой исполнитель не назван');
    expect(text).toContain('которых Платформа показывает на своей витрине, и она может быть передана нескольким из них');
    expect(text).toContain('Передаются имя, контактные данные и текст заявки');
    expect(text).toContain('Редакция от 14 ноября 2026 г.');
  });
});

/* ─── Каждая форма, отправляющая заявку ──────────────────────────────────── */

const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'tests', 'api']);
function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.tsx')) acc.push(full);
  }
}
/** Клиентские файлы, которые POST-ят заявку в `/api/leads`. */
function leadSenders(): Array<{ file: string; src: string }> {
  const files: string[] = [];
  walk(join(ROOT, 'app'), files);
  walk(join(ROOT, 'components'), files);
  return files
    .map((f) => ({ file: relative(ROOT, f).split('\\').join('/'), src: readFileSync(f, 'utf-8') }))
    .filter(({ src }) => /fetch\(\s*['"`]\/api\/leads['"`]/.test(src))
    .sort((a, b) => a.file.localeCompare(b.file));
}

describe('у каждой формы заявки текст согласия по адресату', () => {
  const senders = leadSenders();

  it('форм найдено: с адресатом и без — правило есть что проверять', () => {
    const addressed = senders.filter(({ src }) => /partner_slug\s*:/.test(src)).map((s) => s.file);
    const unaddressed = senders.filter(({ src }) => !/partner_slug\s*:/.test(src)).map((s) => s.file);
    expect(addressed.length).toBeGreaterThan(0);
    expect(unaddressed).toEqual([
      'app/_home/_HomeV8Client.tsx',
      'app/contact/_ContactClient.tsx',
      'app/hub/tourist/trips/[id]/_TripDetailClient.tsx',
      'app/planner/_PlannerClient.tsx',
      'app/request/_RequestClient.tsx',
      'components/routes/LeadModal.tsx',
    ]);
  });

  for (const { file, src } of leadSenders()) {
    const addressed = /partner_slug\s*:/.test(src);
    if (addressed) {
      it(`${file}: адресат назван — форма не говорит о «туроператорах»`, () => {
        expect(src).not.toMatch(/purpose="operators"/);
        expect(src).not.toMatch(/pd_consent_purpose:\s*'operators'/);
      });
    } else {
      it(`${file}: адресата нет — галочки с текстом одного туроператора и запроса без названного текста быть не должно`, () => {
        // Галочка без purpose показывает «туроператору» (умолчание компонента).
        const boxes = src.match(/<PdConsentCheckbox\b[^>]*>/g) ?? [];
        expect(boxes.length, 'галочки согласия нет').toBeGreaterThan(0);
        expect(boxes.filter((b) => !/purpose="operators"/.test(b))).toEqual([]);
        // Каждое тело запроса с согласием называет показанный текст.
        const consents = src.match(/pd_consent:\s*true/g) ?? [];
        const named = src.match(/pd_consent_purpose:\s*'operators'/g) ?? [];
        expect(named.length).toBe(consents.length);
      });
    }
  }
});
