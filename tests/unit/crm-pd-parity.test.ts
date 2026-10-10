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
 *   оператор     — поля брони, где их нет — аккаунта (экран «Бронирования»);
 *   жильё        — имя, телефон и почта аккаунта гостя (уведомление о брони);
 *   перевозчик   — телефон заказа и имя заказавшего партнёра (`listSeatRequests`);
 *   гид          — ничего: его доступ временный (`lib/guides/team-queries.ts`);
 *   запрос мест  — не источник: контакты после «есть места» (решение 29.09).
 *
 * Первая редакция (09.10, до влития) сверяла только экраны броней и потому
 * отняла бы у оператора и жилья телефоны, которые они получают сегодня:
 * «Клиенты» оператора показывали аккаунт, уведомление жилья — телефон гостя.
 * С 10.10 (1а-2b) старый экран «Клиенты» удалён — аккаунт туриста оператор
 * получает на экране «Бронирования» (`/api/operator/bookings`), и паритет
 * держится им.
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
    // Паритет держится «Бронированиями» оператора: перестанут они показывать
    // аккаунт — пересмотреть и это правило.
    expect(read('app/api/operator/bookings/route.ts')).toMatch(/u\.name as user_name,\s+u\.email as user_email,\s+u\.phone as user_phone/);
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

describe('заголовки ленты строит код из статусов и названий', () => {
  it('в statusChangeTitle нет ни телефона, ни почты — только словарь статусов', () => {
    const src = read('lib/crm/events.ts');
    const fn = /export function statusChangeTitle[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(fn.length).toBeGreaterThan(50);
    expect(fn).not.toMatch(/phone|email|person_name|display_name/);
    expect(fn).toMatch(/statusLabel\(/);
  });
});

describe('ПД из CRM не уходят ни в модель, ни в лог', () => {
  const files = readdirSync(join(ROOT, 'lib', 'crm')).map((n) => `lib/crm/${n}`);

  it('слой CRM не зовёт модели: граница ПД (#2318) — модель видит id, а не телефон', () => {
    // Данные для модели готовит один файл — lib/crm/tools.ts (шаг 1д), и
    // моделей он тоже не зовёт: зовёт вызывающий. Что в его ответах нет
    // телефонов и почт, держит исполнением tests/unit/crm-tools-model-safe.
    expect(files).toContain('lib/crm/tools.ts');
    for (const f of files) {
      expect(read(f), f).not.toMatch(/from '@\/lib\/(ai|kuzmich)\//);
    }
  });

  it('логи CRM — вид источника и SQLSTATE, без имени, телефона и почты', () => {
    // Роуты CRM находятся обходом: новая дверь попадает под правило сама.
    const routesUnder = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? routesUnder(`${dir}/${e.name}`) : e.name === 'route.ts' ? [`${dir}/${e.name}`] : []));
    const routes = [...routesUnder('app/api/hub/crm'), ...routesUnder('app/api/admin/crm')];
    expect(routes).toContain('app/api/hub/crm/tasks/[id]/route.ts');
    const logged = [
      ...files,
      'app/api/cron/crm-contacts-sync/route.ts',
      ...routes,
    ]
      .flatMap((f) => [...read(f).matchAll(/console\.(?:error|warn|log)\(([^;]*?)\);/gs)].map((m) => `${f}: ${m[1]}`));
    expect(logged.length).toBeGreaterThan(3);
    for (const line of logged) {
      expect(line).not.toMatch(/\b(phone|email|person_name|display_name|row\b|k\.name)/);
    }
  });
});
