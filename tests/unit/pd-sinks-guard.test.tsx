/**
 * Сторож ПД на стоках вне модели (слово владельца 16.11 «Делай сторож»).
 *
 * Имя и телефон человека не уходят в хранилище браузера без записи в реестре,
 * в открытый лог, в Telegram и в строку адреса. Промпт модели держит D1
 * (`compliance-pii-flow.test.ts`); проверку владельца в ответе статикой не
 * поймать — её держат сторожа своих дверей.
 *
 * Три части:
 *  1. перепись репозитория — нарушений нет, реестры не устарели;
 *  2. прежние случаи, воспроизведённые фикстурами, — сторож их ловит, а
 *     проверку наличия, маску и адрес получателя — нет;
 *  3. рендер: «Выйти» стирает данные аккаунта, а записанные пробелы
 *     действительно не стираются (иначе запись устарела).
 */
import React from 'react';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { scanSinks, deviceWrites, pdKindOf } from '@/lib/agents/compliance/pd-sinks';
import {
  DEVICE_STORAGE, ALLOWED_FINDINGS, sinkCensus, sinkCensusOfRepo, findingKey,
} from '@/lib/agents/compliance/pd-sinks-registry';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { resetSessionState } from '@/lib/auth/session-state';

const REPO = join(__dirname, '..', '..');
const show = (xs: ReadonlyArray<unknown>) => JSON.stringify(xs, null, 2);

describe('перепись репозитория', () => {
  const census = sinkCensusOfRepo(REPO);

  it('ни имя, ни телефон не уходят в лог, Telegram, адрес и хранилище без записи', () => {
    expect(census.violations, `ПД в стоке. Почините маской (PD_SANITIZERS) или проверкой наличия; разрешение — ALLOWED_FINDINGS с причиной:\n${show(census.violations)}`).toEqual([]);
  });

  it('каждый файл, пишущий на устройство человека, записан в DEVICE_STORAGE', () => {
    expect(census.unregistered.map((u) => u.file), `Новый писатель в хранилище браузера. Скажите в DEVICE_STORAGE, что там лежит и чьё оно:\n${show(census.unregistered)}`).toEqual([]);
  });

  it('реестры не устарели: запись без писателя и разрешение без находки — удалить', () => {
    expect(census.staleDevice.map((e) => e.file)).toEqual([]);
    expect(census.staleAllowed.map(findingKey)).toEqual([]);
  });

  it('у записей реестра есть смысл: что лежит, почему остаётся, какие ключи стирать', () => {
    const files = DEVICE_STORAGE.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    for (const e of DEVICE_STORAGE) {
      expect(e.holds.trim().length, e.file).toBeGreaterThan(5);
      if (e.personal === 'own-device') expect(e.why?.trim(), `${e.file}: own-device без причины`).toBeTruthy();
      if (e.personal === 'account' || e.personal === 'gap') expect(e.keys?.length, `${e.file}: нет ключей`).toBeGreaterThan(0);
      if (e.fixInFlight) expect(e.personal).toBe('gap');
    }
    for (const a of ALLOWED_FINDINGS) expect(a.reason.trim().length, findingKey(a)).toBeGreaterThan(10);
  });
});

describe('словарь: что здесь ПД', () => {
  it('телефон, почта, имя человека — да; адрес чата, ИНН компании, телефон МЧС — нет', () => {
    expect(pdKindOf('phone')).toBe('contact');
    expect(pdKindOf('touristPhone')).toBe('contact');
    expect(pdKindOf('customer_email')).toBe('contact');
    expect(pdKindOf('guest_name')).toBe('name');
    expect(pdKindOf('ipAddress')).toBe('contact');
    expect(pdKindOf('chat_id')).toBeNull();
    expect(pdKindOf('inn')).toBeNull();
    expect(pdKindOf('mchs_phone')).toBeNull();
    expect(pdKindOf('company_name')).toBeNull();
    expect(pdKindOf('title')).toBeNull();
  });
});

describe('прежние случаи ловятся', () => {
  it('23.08: имя и телефон лида в Telegram (правило — только MAX, заглушка без ПД)', () => {
    const src = [
      "await tgSend(chatId, `Новый лид: ${lead.name}, ${lead.phone}`);",
      'await sendPdAlert({',
      '  text: `Лид ${lead.name} ${lead.phone}`,',
      '  stub: `Новая заявка от ${lead.name}, тел. ${lead.phone}`,',
      '  to: { maxChatId, telegramChatId },',
      '});',
    ].join('\n');
    const got = scanSinks('lib/x.ts', src).map((f) => `${f.kind}:${f.line}:${f.sink}:${f.expr}`);
    expect(got).toEqual([
      'telegram:1:tgSend:lead.name',
      'telegram:1:tgSend:lead.phone',
      'telegram:4:sendPdAlert stub:lead.name',
      'telegram:4:sendPdAlert stub:lead.phone',
    ]);
  });

  it('прямой запрос к api.telegram.org с телефоном', () => {
    const src = "await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body: JSON.stringify({ chat_id: chatId, text: `Звонить ${booking.customer_phone}` }) });";
    expect(scanSinks('lib/x.ts', src).map((f) => f.expr)).toEqual(['booking.customer_phone']);
  });

  it('#3203: печать в лог — в том числе многострочная и из скрипта Actions', () => {
    const src = [
      "console.log('[lead]', lead.phone);",
      'console.error(',
      '  `не дошло до ${touristEmail}`,',
      ');',
      "logger.info('заявка', { name: booking.customer_name });",
      'process.stdout.write(`${row.client_name}\\n`);',
      "logStayFailure('бронь', err, guestPhone);",
    ].join('\n');
    const got = scanSinks('scripts/eval.mjs', src).map((f) => `${f.line}:${f.sink}:${f.expr}`);
    expect(got).toEqual([
      '1:console.log:lead.phone',
      '3:console.error:touristEmail',
      '5:logger.info:booking.customer_name',
      '6:process.stdout.write:row.client_name',
      '7:logStayFailure:guestPhone',
    ]);
  });

  it('телефон в строке адреса', () => {
    const src = [
      'await fetch(`/api/requests?phone=${phone}&tour=${tourId}`);',
      "url.searchParams.set('email', email);",
    ].join('\n');
    expect(scanSinks('app/x.tsx', src).map((f) => `${f.kind}:${f.sink}`)).toEqual(['url:адрес ?phone=', 'url:адрес email']);
  });

  it('OrdersContext: заказ с телефоном покупателя в localStorage — в файле с родом none это нарушение', () => {
    const src = "localStorage.setItem('orders', JSON.stringify({ phone: order.customerPhone, name: order.customerName }));";
    const c = sinkCensus([{ rel: 'contexts/X.tsx', src }], [{ rel: 'contexts/X.tsx', src }],
      [{ file: 'contexts/X.tsx', personal: 'none', holds: 'будто бы ничего' }], []);
    expect(c.violations.map((f) => f.expr)).toEqual(['order.customerPhone', 'order.customerName']);
  });

  it('#3425: новый писатель в хранилище без записи в реестре — красный', () => {
    const src = "localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(form));";
    const c = sinkCensus([], [{ rel: 'app/planner/_New.tsx', src }], [], []);
    expect(c.unregistered.map((u) => u.file)).toEqual(['app/planner/_New.tsx']);
  });

  it('устаревшие записи реестров краснеют', () => {
    const c = sinkCensus([], [], [{ file: 'app/gone.tsx', personal: 'none', holds: 'ушло' }],
      [{ file: 'lib/gone.ts', sink: 'console.log', expr: 'x.phone', reason: 'файла больше нет' }]);
    expect(c.staleDevice.map((e) => e.file)).toEqual(['app/gone.tsx']);
    expect(c.staleAllowed.map(findingKey)).toEqual(['lib/gone.ts|console.log|x.phone']);
  });
});

describe('ложных срабатываний нет', () => {
  it('маска, проверка наличия, длина, ключ объекта, адрес получателя, строки и комментарии', () => {
    const src = [
      "console.log('[lead]', maskPhone(lead.phone));",
      "console.log('телефон есть:', !!lead.phone, Boolean(guestEmail));",
      "console.log(lead.phone ? 'да' : 'нет', lead.email === null, phone?.length);",
      "console.warn('без телефона', { phone: 'скрыт' });",
      "console.log('lead.phone');",
      '// console.log(lead.phone)',
      'await tgSend(contact.telegram_id, text);',
      "await sendPdAlert({ text: `${lead.name} ${lead.phone}`, stub: 'Новая заявка, контакты в MAX', to });",
      'function logStayFailure(scope: string, guestPhone: string) { return scope + guestPhone; }',
      "console.log(company_name, route.title, mchs_phone);",
      "console.log(redactPII(`${lead.name}: ${lead.phone}`));",
    ].join('\n');
    expect(scanSinks('lib/x.ts', src)).toEqual([]);
  });

  it('параметр адреса из другой строки и Map тела запроса — не адрес', () => {
    const src = [
      "const body = new FormData(); body.set('phone', phone);",
      "await fetch('/api/requests', { method: 'POST', body: JSON.stringify({ phone }) });",
    ].join('\n');
    expect(scanSinks('app/x.tsx', src)).toEqual([]);
  });
});

describe('записи на устройство находятся все', () => {
  it('localStorage, sessionStorage, IndexedDB, Cache API, cookie', () => {
    const src = [
      "localStorage.setItem('a', '1');",
      "window.sessionStorage['b'] = '2';",
      "const db = await openDB<Schema>('x', 1, {});",
      "const c = await caches.open('trips');",
      'document.cookie = `self=1`;',
      "const v = localStorage.getItem('a');",
    ].join('\n');
    expect(deviceWrites(src).map((w) => `${w.line}:${w.api}`)).toEqual([
      '1:localStorage', '2:sessionStorage', '3:IndexedDB', '4:Cache API', '5:cookie',
    ]);
  });
});

// --- 3. «Выйти»: рендер настоящего AuthProvider

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const USER = {
  id: 'u-1', email: 'test@example.com', name: 'Тест', role: 'tourist', roles: ['tourist'],
  preferences: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

function Probe() {
  const { user, isLoading, signOut } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <span>{user ? `user:${user.name}` : 'guest'}</span>
      <button onClick={() => { signOut().catch(() => undefined); }}>Выйти</button>
    </div>
  );
}

describe('«Выйти» и реестр хранилища', () => {
  const accountKeys = [...new Set(DEVICE_STORAGE.filter((e) => e.personal === 'account').flatMap((e) => e.keys ?? []))];
  const gaps = DEVICE_STORAGE.filter((e) => e.personal === 'gap');

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetSessionState();
    localStorage.setItem('user', JSON.stringify(USER));
    for (const k of accountKeys) if (k !== 'user') localStorage.setItem(k, '["tourist"]');
    for (const g of gaps) for (const k of g.keys ?? []) localStorage.setItem(k, '{"seeded":true}');
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: USER }) }));
  });

  it('данные аккаунта стёрты; записанные пробелы остаются — иначе запись устарела', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('user:Тест')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Выйти'));
    await waitFor(() => expect(screen.getByText('guest')).toBeInTheDocument());
    await waitFor(() => { for (const k of accountKeys) expect(localStorage.getItem(k), k).toBeNull(); });
    for (const g of gaps) {
      if (g.fixInFlight) continue; // правка идёт: оба состояния честны до её вливания
      for (const k of g.keys ?? []) {
        expect(localStorage.getItem(k), `«Выйти» уже стирает ${k} — переведите ${g.file} в account`).not.toBeNull();
      }
    }
  });
});
