/**
 * Сторож шага 1а-2b (CRM #2325): «Клиенты» оператора переехали на контакты CRM.
 *
 * Старый экран (`/api/operator/clients`, до 10.10) строился от аккаунтов:
 * гостевая бронь, лид и клиент, заведённый руками, в «Клиенты» не попадали.
 * Он же считал суммы и VIP, выгружал CSV и хранил метки с Telegram в
 * operator_client_notes. Переезд держит всё это, а не теряет:
 *  - суммы, сегмент и итоги — только у оператора, и фильтр, которого у роли
 *    нет, отвечает словами, а не молча отдаёт весь список (§4.0);
 *  - CSV собирает сервер: формула в имени клиента становится текстом,
 *    больше предела — отказ, а не обрезанный файл;
 *  - метки и Telegram перенесены миграцией 1200 (её исполнение на настоящем
 *    PostgreSQL — в tests/integration/operator-screens.pg.test.ts);
 *  - старого экрана, его API и модалки больше нет — второй экран одних
 *    клиентов разошёлся бы с первым.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const requirePartner = vi.fn();
const listContacts = vi.fn();
const listOperatorClients = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/crm/contact-queries', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/contact-queries')>()),
  listContacts: (...a: unknown[]) => listContacts(...a),
}));
vi.mock('@/lib/crm/operator-clients', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/operator-clients')>()),
  listOperatorClients: (...a: unknown[]) => listOperatorClients(...a),
}));

const list = await import('@/app/api/hub/crm/contacts/route');
const exp = await import('@/app/api/hub/crm/contacts/export/route');
const { contactsToCsv, EXPORT_MAX_ROWS } = await import('@/lib/crm/contacts-export');
const { OPERATOR_CLIENTS_LIST_SQL } = await import('@/lib/crm/operator-clients');

const OPERATOR = { outcome: 'ok', partnerId: 'op-1', category: 'operator', userId: 'u-1' };
const GUIDE = { outcome: 'ok', partnerId: 'g-1', category: 'guide', userId: 'u-2' };
const req = (url: string) => new NextRequest(`http://localhost${url}`);

const ITEM = {
  id: 'c-1', display_name: '=HYPERLINK("http://x")', phone: '+79990000000', email: 'a@b.ru',
  tags: ['постоянный', 'семья'], origin: 'operator_booking',
  first_seen_at: '2026-09-01T00:00:00.000Z', last_activity_at: '2026-10-05T03:00:00.000Z',
  consent_recorded: true, sources_count: 2,
  stats: { bookings: 3, booked_sum: 125000, last_booking_at: '2026-10-05T03:00:00.000Z', segment: 'vip' as const },
};
const SUMMARY = { clients: 1, vip: 1, bookings: 3, booked_sum: 125000 };

beforeEach(() => {
  for (const f of [requirePartner, listContacts, listOperatorClients]) f.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('список: суммы и сегмент — у оператора', () => {
  it('оператор получает суммы, сегмент и итоги; фильтры доходят до запроса, скоуп — из гарда', async () => {
    requirePartner.mockResolvedValueOnce(OPERATOR);
    listOperatorClients.mockResolvedValueOnce({ items: [ITEM], total: 1, summary: SUMMARY });
    const r = await list.GET(req('/api/hub/crm/contacts?segment=vip&sort=sum&page=2&partner_id=chuzhoi'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.summary).toEqual(SUMMARY);
    expect(body.data.items[0].stats.segment).toBe('vip');
    expect(listOperatorClients.mock.calls[0][0]).toBe('op-1');
    expect(listOperatorClients.mock.calls[0][1]).toMatchObject({ segment: 'vip', sort: 'sum', offset: 30 });
    expect(listContacts).not.toHaveBeenCalled();
  });

  it('у других ролей сегмента нет — 400 словами, а не весь список под видом отфильтрованного', async () => {
    requirePartner.mockResolvedValueOnce(GUIDE);
    const r = await list.GET(req('/api/hub/crm/contacts?segment=vip'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/только у клиентов оператора/);
    expect(listContacts).not.toHaveBeenCalled();
  });

  it('незнакомый сегмент или порядок — 400', async () => {
    requirePartner.mockResolvedValue(OPERATOR);
    expect((await list.GET(req('/api/hub/crm/contacts?segment=gold'))).status).toBe(400);
    expect((await list.GET(req('/api/hub/crm/contacts?sort=id;drop'))).status).toBe(400);
    expect(listOperatorClients).not.toHaveBeenCalled();
  });

  it('база не ответила — 503, а не пустой список', async () => {
    requirePartner.mockResolvedValueOnce(OPERATOR);
    listOperatorClients.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await list.GET(req('/api/hub/crm/contacts'))).status).toBe(503);
  });
});

describe('правило сегмента и суммы — в SQL', () => {
  it('отменённые и отклонённые брони не считаются; сумма — подтверждённые и завершённые', () => {
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/NOT IN \('cancelled', 'rejected'\)/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/FILTER \(WHERE b\.booking_status IN \('confirmed', 'completed'\)\)/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/WHEN st\.bookings = 0 THEN 'none'/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/st\.bookings >= 3 OR st\.booked_sum >= 100000 THEN 'vip'/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/INTERVAL '1 day' \* 90 /);
  });

  it('брони — только привязанные к контакту этого оператора, удалённые не считаются', () => {
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/l\.partner_id = c\.partner_id/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/l\.source_kind = 'operator_booking'/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/b\.deleted_at IS NULL/);
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/WHERE c\.partner_id = \$1/);
  });

  it('порядок — из параметра в CASE, а не вклеенным текстом', () => {
    expect(OPERATOR_CLIENTS_LIST_SQL).toMatch(/CASE WHEN \$6::text = 'sum'/);
    expect(read('lib/crm/operator-clients-sql.ts')).not.toMatch(/ORDER BY \$\{/);
  });

  it('проба прода разбирает именно эти запросы — из модуля без записи', () => {
    const probe = read('app/api/cron/operator-screens-check/route.ts');
    expect(probe).toMatch(/from '@\/lib\/crm\/operator-clients-sql'/);
    expect(probe).not.toMatch(/from '@\/lib\/crm\/operator-clients'/);
    expect(read('lib/crm/operator-clients-sql.ts')).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|db-pool/);
    for (const name of ['OPERATOR_CLIENTS_LIST_SQL', 'OPERATOR_CLIENTS_COUNT_SQL', 'OPERATOR_CLIENTS_SUMMARY_SQL']) {
      expect(probe).toMatch(new RegExp(`sql: ${name}`));
    }
  });
});

describe('выгрузка CSV', () => {
  it('формула в имени клиента становится текстом, суммы и сегмент — только у оператора', () => {
    const csv = contactsToCsv([ITEM], true);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('Сумма подтверждённых броней, ₽');
    expect(csv).toContain(';125000;');
    expect(csv).toContain(';VIP');
    // День — по Камчатке: 03:00 UTC 05.10 — уже 15:00 того же дня.
    expect(csv).toContain('05.10.2026');
    const plain = contactsToCsv([ITEM], false);
    expect(plain).not.toContain('Сегмент');
    expect(plain).not.toContain('125000');
  });

  it('имени нет — пустая ячейка, а не выдуманное «Без имени»', () => {
    const csv = contactsToCsv([{ ...ITEM, display_name: null }], false);
    expect(csv.split('\n')[1].startsWith(';')).toBe(true);
    expect(csv).not.toMatch(/Без имени/);
  });

  it('оператор выгружает своих клиентов тем же фильтром; файл — вложением, без кэша', async () => {
    requirePartner.mockResolvedValueOnce(OPERATOR);
    listOperatorClients.mockResolvedValueOnce({ items: [ITEM], total: 1, summary: SUMMARY });
    const r = await exp.GET(req('/api/hub/crm/contacts/export?q=Анна&tag=семья&segment=vip'));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toMatch(/text\/csv/);
    expect(r.headers.get('Content-Disposition')).toMatch(/^attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(listOperatorClients.mock.calls[0][0]).toBe('op-1');
    expect(listOperatorClients.mock.calls[0][1]).toMatchObject({ q: 'Анна', tag: 'семья', segment: 'vip', limit: EXPORT_MAX_ROWS + 1 });
  });

  it('больше предела — 413 со словами, а не обрезанный файл', async () => {
    requirePartner.mockResolvedValueOnce(GUIDE);
    listContacts.mockResolvedValueOnce({ items: [], total: EXPORT_MAX_ROWS + 1 });
    const r = await exp.GET(req('/api/hub/crm/contacts/export'));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/Сузьте поиском/);
  });

  it('сегмент у не-оператора — 400; база не ответила — 503', async () => {
    requirePartner.mockResolvedValueOnce(GUIDE);
    expect((await exp.GET(req('/api/hub/crm/contacts/export?segment=vip'))).status).toBe(400);
    requirePartner.mockResolvedValueOnce(GUIDE);
    listContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await exp.GET(req('/api/hub/crm/contacts/export'))).status).toBe(503);
  });
});

describe('переезд без потерь и без второго экрана', () => {
  it('страница оператора рендерит общий экран CRM', () => {
    const page = read('app/hub/operator/clients/page.tsx');
    expect(page).toMatch(/<ContactsScreen \/>/);
    expect(page).toMatch(/robots: 'noindex, nofollow'/);
  });

  it('старого экрана, его API и модалки нет', () => {
    for (const f of [
      'app/hub/operator/clients/_ClientsPageClient.tsx',
      'components/operator/CustomerProfileModal.tsx',
      'app/api/operator/clients/route.ts',
      'app/api/operator/clients/[id]/route.ts',
    ]) expect(existsSync(join(ROOT, f)), f).toBe(false);
    expect(read('lib/operator/screen-queries.ts')).not.toMatch(/buildClientsSql|CLIENTS_CTE/);
  });

  it('миграция 1200 переносит метки и Telegram по паре (оператор, аккаунт), источник не трогает', () => {
    const sql = read('migrations/1200_operator_client_notes_to_crm.sql');
    expect(sql).toMatch(/UPDATE crm_contacts c/);
    expect(sql).toMatch(/FROM operator_client_notes n/);
    expect(sql).toMatch(/c\.partner_id = n\.operator_id\s+AND c\.user_id = n\.user_id/);
    expect(sql).toMatch(/\[1:20\]/);
    expect(sql).toMatch(/'Telegram: '/);
    expect(sql).not.toMatch(/DELETE FROM operator_client_notes|DROP TABLE/);
  });

  it('экран и API больше не читают и не пишут operator_client_notes', () => {
    for (const f of ['app/api/hub/crm/contacts/route.ts', 'lib/crm/operator-clients.ts', 'lib/crm/operator-clients-sql.ts', 'lib/crm/contact-queries.ts', 'components/crm/ContactsScreen.tsx']) {
      expect(read(f), f).not.toMatch(/operator_client_notes/);
    }
  });

});
