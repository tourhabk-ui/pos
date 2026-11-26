/**
 * Письмо партнёру об одобрении заявки (lib/operator/approval-email).
 *
 * Ревью безопасности 23.11 (PR #3801) заметило: письмо об отказе имя и
 * название компании экранирует, а письмо об одобрении подставляло их в HTML
 * как есть. Здесь — письмо вызовом и роут решения целиком: в отправленном
 * письме разметка из имени и названия не исполняется, слова письма прежние.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
const sendMock = vi.fn(async (_mail: { to: string; subject: string; html: string }) => undefined);
vi.mock('@/lib/database', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'c4000000-0000-4000-8000-0000000002ad', role: 'admin' })),
}));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: (mail: { to: string; subject: string; html: string }) => sendMock(mail) } }));
vi.mock('@/lib/partners/storefront-gate', () => ({
  storefrontChannelGate: vi.fn(async () => ({ outcome: 'ok' })), NO_CHANNEL_TEXT: 'нет канала', CHANNEL_UNKNOWN_TEXT: 'канал не проверен',
}));

import { approvalEmailHtml, approvalEmailSubject } from '@/lib/operator/approval-email';
import { PATCH } from '@/app/api/admin/operators/[id]/route';

const ID = 'c5000000-0000-4000-8000-000000000021';
const HOSTILE = '<img src=x onerror="alert(1)">&"\'';
const HOSTILE_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&quot;&#39;';

describe('письмо об одобрении: слова по роли', () => {
  const base = { contactName: 'Тест', companyName: 'Тестовая компания', partnerId: ID };

  it('оператору — заявка компании и кабинет оператора', () => {
    const html = approvalEmailHtml({ ...base, category: 'operator' });
    expect(html).toContain('<p>Здравствуйте, <b>Тест</b>!</p>');
    expect(html).toContain('Заявка компании <b>Тестовая компания</b> одобрена. Теперь вы можете публиковать туры.');
    expect(html).toContain('<a href="https://vedarai.ru/hub/operator">Перейти в кабинет →</a>');
  });

  it('гиду — профиль в реестре гидов и ссылка на его страницу; про туры и кабинет оператора — ни слова', () => {
    const html = approvalEmailHtml({ ...base, category: 'guide' });
    expect(html).toContain('Профиль гида <b>Тестовая компания</b> проверен и одобрен. Теперь он виден туристам в реестре гидов.');
    expect(html).toContain(`<a href="https://vedarai.ru/guides/${ID}">Открыть профиль на сайте →</a>`);
    expect(html).not.toContain('публиковать туры');
    expect(html).not.toContain('/hub/operator');
  });

  it('агенту — кабинет агента; витрины ему письмо не обещает', () => {
    const html = approvalEmailHtml({ ...base, category: 'agent' });
    expect(html).toContain('Профиль агента <b>Тестовая компания</b> проверен и одобрен.');
    expect(html).toContain('<a href="https://vedarai.ru/hub/agent">Перейти в кабинет агента →</a>');
    expect(html).not.toContain('виден туристам');
  });

  it('тема письма — по роли', () => {
    expect(approvalEmailSubject('agent')).toBe('Кабинет агента открыт — Ведар');
    expect(approvalEmailSubject('guide')).toBe('Профиль гида одобрен — Ведар');
    for (const category of ['operator', 'stay', null]) expect(approvalEmailSubject(category)).toMatch(/^Ваша заявка одобрена/);
  });

  it('имя и компания — текст людей: разметка в письме не исполняется, у каждой роли', () => {
    for (const category of ['operator', 'guide', 'agent', 'stay', null]) {
      const html = approvalEmailHtml({ contactName: HOSTILE, companyName: HOSTILE, category, partnerId: ID });
      expect(html, String(category)).not.toContain('<img');
      expect(html, String(category)).not.toContain('onerror="');
      // Оба места — приветствие и название — экранированы.
      expect(html.split(HOSTILE_ESCAPED), String(category)).toHaveLength(3);
      // Своя разметка письма на месте.
      expect(html, String(category)).toMatch(/<a href="https:\/\/vedarai\.ru\/[a-z/0-9-]+">/);
    }
  });

  it('id карточки в адресе профиля гида закодирован', () => {
    const html = approvalEmailHtml({ contactName: 'Тест', companyName: 'Гид', category: 'guide', partnerId: '"><script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('https://vedarai.ru/guides/%22%3E%3Cscript%3Ex%3C%2Fscript%3E');
  });

  it('имени или названия нет — пустое место, а не «null»', () => {
    const html = approvalEmailHtml({ contactName: null, companyName: null, category: 'operator', partnerId: ID });
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
  });
});

describe('PATCH /api/admin/operators/[id] — одобрение', () => {
  const approve = () => PATCH(
    new Request(`http://localhost/api/admin/operators/${ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: ID }) },
  );
  const partnerRow = (over: Record<string, unknown>) => ({
    id: ID, company_name: `Компания ${HOSTILE}`, profile_status: 'pending', category: 'operator',
    is_public: false, is_test: false, user_id: 'u1', email: 'op@example.test', contact_name: `Тест ${HOSTILE}`, ...over,
  });
  let row: Record<string, unknown> = {};

  beforeEach(() => {
    queryMock.mockReset();
    sendMock.mockClear();
    row = partnerRow({});
    queryMock.mockImplementation((sql: string) => {
      if (/FROM partners p\s+JOIN users u/i.test(sql)) return Promise.resolve({ rows: [row] });
      // Чата в Telegram у карточки нет: сообщение туда не уходит.
      if (/telegram_chat_id/.test(sql)) return Promise.resolve({ rows: [{ chat_id: null }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  });

  it('оператор одобрен: письмо ушло на его почту, имя и компания в нём экранированы', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(String(queryMock.mock.calls.find(([sql]) => /UPDATE partners/.test(String(sql)))?.[0])).toMatch(/profile_status = 'approved'/);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe('op@example.test');
    expect(mail.subject).toMatch(/^Ваша заявка одобрена/);
    expect(mail.html).toContain(`Здравствуйте, <b>Тест ${HOSTILE_ESCAPED}</b>!`);
    expect(mail.html).toContain(`Заявка компании <b>Компания ${HOSTILE_ESCAPED}</b> одобрена.`);
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('onerror="');
  });

  it('гид и агент: письмо по роли, с теми же экранированными именем и названием', async () => {
    row = partnerRow({ category: 'guide' });
    expect((await approve()).status).toBe(200);
    let mail = sendMock.mock.calls[0][0];
    expect(mail.subject).toBe('Профиль гида одобрен — Ведар');
    expect(mail.html).toContain(`Профиль гида <b>Компания ${HOSTILE_ESCAPED}</b> проверен и одобрен.`);
    expect(mail.html).toContain(`https://vedarai.ru/guides/${ID}`);
    expect(mail.html).not.toContain('<img');

    sendMock.mockClear();
    row = partnerRow({ category: 'agent' });
    expect((await approve()).status).toBe(200);
    mail = sendMock.mock.calls[0][0];
    expect(mail.subject).toBe('Кабинет агента открыт — Ведар');
    expect(mail.html).toContain(`Профиль агента <b>Компания ${HOSTILE_ESCAPED}</b> проверен и одобрен.`);
    expect(mail.html).not.toContain('<img');
  });

  it('своего HTML письма об одобрении у роута нет: текст людей мимо экранирования в письмо не попадает', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/api/admin/operators/[id]/route.ts', 'utf8');
    expect(src).not.toMatch(/<b>\$\{partner\./);
    expect(src).not.toMatch(/html:\s*`/);
  });
});
