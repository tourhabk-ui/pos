/**
 * Сторож: CRM не расширяет доступ партнёра к ПД (CRM #2325, pd-guard §3).
 *
 * Клиент партнёра — постоянная запись, собранная из источников. Достаточно
 * одного удобного COALESCE, чтобы она показала больше, чем партнёр получает
 * сегодня: имя и почту аккаунта перевозчику, туриста — гиду после конца тура,
 * туриста запроса мест — оператору, ещё не ответившему «есть места». Каждое
 * правило здесь — паритет с тем, что партнёр уже получает на экранах и в
 * уведомлении о брони:
 *
 *   оператор     — поля брони, где их нет — аккаунта («Клиенты» оператора);
 *   жильё        — имя, телефон и почта аккаунта гостя (уведомление о брони);
 *   перевозчик   — телефон заказа и имя заказавшего партнёра (`listSeatRequests`);
 *   гид          — ничего: его доступ временный (`lib/guides/team-queries.ts`);
 *   запрос мест  — не источник: контакты после «есть места» (решение 29.09).
 *
 * Первая редакция (09.10, до влития) сверяла только экраны броней и потому
 * отняла бы у оператора и жилья телефоны, которые они получают сегодня:
 * «Клиенты» оператора показывают аккаунт, уведомление жилья — телефон гостя.
 * Сверять паритет нужно со ВСЕМ, что партнёр получает, а не с одним экраном.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_KINDS, SOURCE_SQL, UNLINKED_PAGE_SQL } from '@/lib/crm/contacts';
import { SOURCE_SUMMARY_SQL } from '@/lib/crm/contact-queries';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('в контакт — только то, что партнёр уже видит', () => {
  it('оператор: поле брони первым, аккаунт — где брони сказать нечего', () => {
    const sql = flat(SOURCE_SQL.operator_booking);
    for (const [field, alias] of [['name', 'person_name'], ['phone', 'phone'], ['email', 'email']] as const) {
      expect(sql).toContain(`COALESCE(NULLIF(btrim(s.tourist_${field}), ''), u.${field}) AS ${alias}`);
    }
    // Аккаунт — только туриста этой брони, а не любого пользователя.
    expect(sql).toMatch(/LEFT JOIN users u ON u\.id = s\.user_id/);
    // Паритет держится «Клиентами» оператора: перестанут они показывать
    // аккаунт — пересмотреть и это правило.
    expect(read('lib/operator/screen-queries.ts')).toMatch(/u\.name,\s+u\.email,\s+u\.phone/);
  });

  it('жильё: имя, телефон и почта аккаунта гостя — как в уведомлении о брони', () => {
    expect(flat(SOURCE_SQL.accommodation_booking)).toMatch(/u\.name AS person_name, u\.phone, u\.email/);
    expect(flat(SOURCE_SQL.accommodation_booking)).toMatch(/JOIN users u ON u\.id = s\.user_id/);
    // Паритет держится уведомлением: перестанет оно слать телефон — этот
    // тест обязан покраснеть вместе с ним.
    expect(read('lib/notifications/stay-booking.ts')).toMatch(/guestPhone/);
  });

  it('перевозчик: без имени и почты аккаунта туриста', () => {
    const sql = flat(SOURCE_SQL.transfer_seat_booking);
    expect(sql).not.toMatch(/\busers\b/);
    expect(sql).toMatch(/op\.name AS person_name, s\.contact_phone AS phone, NULL::text AS email/);
    expect(flat(SOURCE_SUMMARY_SQL.transfer_seat_booking)).not.toMatch(/\busers\b/);
  });

  it('гид контактов из броней не получает', () => {
    for (const k of SOURCE_KINDS) {
      expect(SOURCE_SQL[k], k).not.toMatch(/guide_partner_id/);
      expect(UNLINKED_PAGE_SQL[k], k).not.toMatch(/guide_partner_id/);
    }
  });

  it('запрос мест — не источник: до «есть места» оператор не знает туриста', () => {
    expect(SOURCE_KINDS as readonly string[]).not.toContain('tour_seat_request');
    for (const k of SOURCE_KINDS) expect(SOURCE_SQL[k], k).not.toMatch(/tour_seat_requests/);
    expect(read('lib/seat-requests/service.ts')).not.toMatch(/linkContactQuietly/);
  });

  it('деньги в сводку источников не идут', () => {
    for (const k of SOURCE_KINDS) {
      expect(SOURCE_SUMMARY_SQL[k], k).not.toMatch(/price|amount|paid|commission/i);
    }
  });
});

describe('ПД из CRM не уходят ни в модель, ни в лог', () => {
  const files = readdirSync(join(ROOT, 'lib', 'crm')).map((n) => `lib/crm/${n}`);

  it('слой CRM не зовёт модели: граница ПД (#2318) — модель видит id, а не телефон', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/from '@\/lib\/(ai|kuzmich)\//);
    }
  });

  it('логи CRM — вид источника и SQLSTATE, без имени, телефона и почты', () => {
    const logged = [
      ...files,
      'app/api/cron/crm-contacts-sync/route.ts',
      'app/api/hub/crm/contacts/route.ts', 'app/api/hub/crm/contacts/[id]/route.ts',
      'app/api/admin/crm/contacts/route.ts', 'app/api/admin/crm/contacts/[id]/route.ts',
    ]
      .flatMap((f) => [...read(f).matchAll(/console\.(?:error|warn|log)\(([^;]*?)\);/gs)].map((m) => `${f}: ${m[1]}`));
    expect(logged.length).toBeGreaterThan(3);
    for (const line of logged) {
      expect(line).not.toMatch(/\b(phone|email|person_name|display_name|row\b|k\.name)/);
    }
  });
});
