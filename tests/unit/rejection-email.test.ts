/**
 * Письмо партнёру об отказе по заявке (lib/operator/rejection-email).
 *
 * Оператор получил дверь повторной подачи (слово владельца 23.11) — и письмо
 * теперь её называет, как называло гиду и агенту. Заодно закрыто старое:
 * имя, название компании и комментарий администратора подставлялись в HTML
 * письма как есть.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
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

import { rejectionEmailHtml } from '@/lib/operator/rejection-email';
import { PATCH } from '@/app/api/admin/operators/[id]/route';

describe('письмо об отказе: слова по роли', () => {
  const base = { contactName: 'Тест', companyName: 'Тестовая компания', comment: null };

  it('оператору названа дверь повторной подачи — профиль компании в кабинете', () => {
    const html = rejectionEmailHtml({ ...base, category: 'operator' });
    expect(html).toContain('заявка компании <b>Тестовая компания</b> не прошла проверку');
    expect(html).toContain('Исправьте профиль компании в кабинете (раздел «Профиль») и отправьте заявку на проверку снова.');
  });

  it('гиду и агенту — их кабинеты; глагол согласован с «профиль»', () => {
    const guide = rejectionEmailHtml({ ...base, category: 'guide' });
    expect(guide).toContain('профиль гида <b>Тестовая компания</b> не прошёл проверку');
    expect(guide).toContain('Исправьте профиль в кабинете гида и отправьте его на проверку снова.');
    const agent = rejectionEmailHtml({ ...base, category: 'agent' });
    expect(agent).toContain('профиль агента <b>Тестовая компания</b> не прошёл проверку');
    expect(agent).toContain('кабинете агента');
  });

  it('роли без двери повторной подачи письмо её не обещает', () => {
    for (const category of ['stay', 'gear', 'transfer', 'cars', null, 'что-то новое']) {
      const html = rejectionEmailHtml({ ...base, category });
      expect(html, String(category)).not.toContain('отправьте');
      expect(html, String(category)).toContain('не прошла проверку');
    }
  });

  it('комментария нет — строки «Комментарий» нет вовсе; пробелы — не комментарий', () => {
    for (const comment of [null, '', '   ']) {
      expect(rejectionEmailHtml({ ...base, category: 'operator', comment })).not.toContain('Комментарий');
    }
    expect(rejectionEmailHtml({ ...base, category: 'operator', comment: ' Нет телефона. ' })).toContain('<p><b>Комментарий:</b> Нет телефона.</p>');
  });

  it('имя, компания и комментарий — текст людей: разметка в письме не исполняется', () => {
    const hostile = '<img src=x onerror="alert(1)">&"\'';
    const html = rejectionEmailHtml({ contactName: hostile, companyName: hostile, category: 'operator', comment: hostile });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    expect(html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&quot;&#39;/g)).toHaveLength(3);
    // Своя разметка письма на месте: три абзаца с тегами и ссылка на почту.
    expect(html).toContain('<a href="mailto:info@vedarai.ru">info@vedarai.ru</a>');
  });

  it('имени или названия нет — пустое место, а не «null»', () => {
    const html = rejectionEmailHtml({ contactName: null, companyName: null, category: 'operator', comment: null });
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
  });
});

describe('PATCH /api/admin/operators/[id] — отказ', () => {
  const ID = 'c5000000-0000-4000-8000-000000000011';
  const reject = (comment?: string) => PATCH(
    new Request(`http://localhost/api/admin/operators/${ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', ...(comment === undefined ? {} : { comment }) }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: ID }) },
  );

  beforeEach(() => {
    queryMock.mockReset();
    sendMock.mockClear();
    queryMock.mockImplementation((sql: string) => {
      if (/^\s*SELECT/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: ID, company_name: 'Компания <b>X</b>', profile_status: 'pending', category: 'operator',
            is_public: false, is_test: false, user_id: 'u1', email: 'op@example.test', contact_name: 'Тест',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  });

  it('причина записана в карточку и в журнал; оператору ушло письмо с дверью и экранированным комментарием', async () => {
    const res = await reject('Нет <телефона>');
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(200);
    const partnerUpdate = queryMock.mock.calls.find(([sql]) => /UPDATE partners/.test(String(sql)));
    expect(String(partnerUpdate?.[0])).toMatch(/profile_status\s*=\s*'rejected'/);
    expect(String(partnerUpdate?.[0])).toMatch(/profile_review_comment\s*=\s*\$2/);
    expect(partnerUpdate?.[1]).toEqual([ID, 'Нет <телефона>']);
    const journal = queryMock.mock.calls.find(([sql]) => /UPDATE operator_applications/.test(String(sql)));
    expect(journal?.[1]).toEqual([ID, 'Нет <телефона>', 'c4000000-0000-4000-8000-0000000002ad']);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe('op@example.test');
    expect(mail.html).toContain('отправьте заявку на проверку снова');
    expect(mail.html).toContain('Нет &lt;телефона&gt;');
    expect(mail.html).toContain('Компания &lt;b&gt;X&lt;/b&gt;');
    expect(mail.html).not.toContain('Нет <телефона>');
  });

  it('без причины: в карточке «не записана» (NULL), в письме строки комментария нет', async () => {
    const res = await reject();
    expect(res.status).toBe(200);
    const partnerUpdate = queryMock.mock.calls.find(([sql]) => /UPDATE partners/.test(String(sql)));
    expect(partnerUpdate?.[1]).toEqual([ID, null]);
    expect(sendMock.mock.calls[0][0].html).not.toContain('Комментарий');
  });
});
