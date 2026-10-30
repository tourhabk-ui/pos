/**
 * Сторож: у каждого источника клиента есть производитель (CRM #2325, правило
 * 10.09 «объявленный исход без источника»).
 *
 * Клиент партнёра заводится хуком `linkContactQuietly` там, где создаётся
 * строка источника. Новая дверь брони, заказа или лида без хука — это клиент,
 * которого партнёр не увидит, пока кто-нибудь не вспомнит позвать задел. Тест
 * находит двери ПО КОДУ: любой файл с `INSERT INTO` в одну из семи таблиц
 * обязан звать хук своего вида после вставки — либо стоять в
 * `KNOWN_WITHOUT_HOOK` с причиной. Список самоустаревающий: дверь пропала —
 * запись требует убрать.
 *
 * С 15.10 (аудит, P2-01) строку `operator_bookings` пишет одна общая
 * `insertBookingRow` (lib/bookings/reserve.ts), и дверь брони видна по её
 * вызову, а не по тексту INSERT. Без этого перенос вставки в общую функцию
 * молча вывел бы OCTO и ручную бронь оператора из-под этого сторожа.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SOURCE_KINDS, UNLINKED_COUNT_SQL, UNLINKED_PAGE_SQL, type SourceKind } from '@/lib/crm/contacts';

const ROOT = process.cwd();

const TABLE_KIND: Readonly<Record<string, SourceKind>> = {
  operator_bookings: 'operator_booking',
  accommodation_bookings: 'accommodation_booking',
  gear_rentals: 'gear_rental',
  transfer_seat_bookings: 'transfer_seat_booking',
  leads: 'lead',
  agent_clients: 'agent_client',
  stay_requests: 'stay_request',
};

const KNOWN_WITHOUT_HOOK: Readonly<Record<string, string>> = {
  'app/api/cron/payment-test-setup/route.ts':
    'проба оплаты: тестовая бронь не клиент оператора',
  'app/api/cron/sql-shape-check/route.ts':
    'только PREPARE: вывод типов на разборе, ни одна строка не вставляется',
};

const INSERT_RE = new RegExp(
  String.raw`INSERT\s+INTO\s+(?:public\.)?(${Object.keys(TABLE_KIND).join('|')})\b`,
  'g',
);

/** Вызов общей вставки строки брони — та же дверь в operator_bookings. */
const BOOKING_ROW_CALL_RE = /\binsertBookingRow\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function inserters(): Map<string, { src: string; tables: Set<string>; firstInsert: number }> {
  const found = new Map<string, { src: string; tables: Set<string>; firstInsert: number }>();
  for (const abs of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]) {
    const src = readFileSync(abs, 'utf8');
    const matches = [
      ...[...src.matchAll(INSERT_RE)].map((m) => ({ table: m[1], index: m.index ?? 0 })),
      ...[...src.matchAll(BOOKING_ROW_CALL_RE)].map((m) => ({ table: 'operator_bookings', index: m.index ?? 0 })),
    ];
    if (matches.length === 0) continue;
    found.set(relative(ROOT, abs), {
      src,
      tables: new Set(matches.map((m) => m.table)),
      firstInsert: Math.min(...matches.map((m) => m.index)),
    });
  }
  return found;
}

describe('у каждой двери источника есть хук клиента', () => {
  const all = inserters();

  it('перепись находит двери (иначе сторож пуст и зелен по ошибке)', () => {
    // Все виды, у каждого хотя бы одна дверь с хуком.
    const hooked = new Set<SourceKind>();
    for (const [, f] of all) {
      for (const t of f.tables) {
        if (f.src.includes(`linkContactQuietly('${TABLE_KIND[t]}'`)) hooked.add(TABLE_KIND[t]);
      }
    }
    expect([...hooked].sort()).toEqual([...SOURCE_KINDS].sort());
  });

  it('файл со вставкой в источник зовёт хук своего вида после вставки', () => {
    const missing: string[] = [];
    for (const [file, f] of all) {
      if (file in KNOWN_WITHOUT_HOOK) continue;
      if (!/import\s*\{[^}]*\blinkContactQuietly\b[^}]*\}\s*from\s*'@\/lib\/crm\/contacts'/.test(f.src)) {
        missing.push(`${file}: нет импорта linkContactQuietly`);
        continue;
      }
      for (const table of f.tables) {
        const call = f.src.indexOf(`linkContactQuietly('${TABLE_KIND[table]}'`);
        if (call < 0) missing.push(`${file}: нет хука '${TABLE_KIND[table]}' для ${table}`);
        else if (call < f.firstInsert) missing.push(`${file}: хук '${TABLE_KIND[table]}' стоит ДО вставки`);
      }
    }
    expect(missing, 'новая дверь источника — хук после вставки или запись в KNOWN_WITHOUT_HOOK с причиной').toEqual([]);
  });

  it('исключения названы причиной и не пережили свою дверь', () => {
    for (const [file, reason] of Object.entries(KNOWN_WITHOUT_HOOK)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(all.has(file), `${file} больше не вставляет в источник — убрать из KNOWN_WITHOUT_HOOK`).toBe(true);
    }
  });

  it('служебная бронь пробы оплаты не становится клиентом: отбор задела её исключает', () => {
    // payment-test-setup пишет created_via = 'service-payment-test' и не
    // заполняет туриста; перепись 09.10 (run 104) нашла её единственной
    // непривязанной строкой, которую задел перебирал впустую.
    for (const sql of [UNLINKED_COUNT_SQL.operator_booking, UNLINKED_PAGE_SQL.operator_booking]) {
      expect(sql).toMatch(/created_via IS DISTINCT FROM 'service-payment-test'/);
    }
    expect(readFileSync(join(ROOT, 'app/api/cron/payment-test-setup/route.ts'), 'utf8')).toMatch(/'service-payment-test'/);
  });

  it('bookingService по-прежнему без потребителей (create снят 15.10, остальное — тоже мёртвое)', () => {
    const users = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'components'))]
      .map((abs) => relative(ROOT, abs))
      .filter((rel) => rel !== 'lib/services/tours/booking.service.ts' && rel !== 'lib/services/index.ts')
      .filter((rel) => /\bbookingService\b/.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(users, 'bookingService начали звать — мёртвый код ожил, ему нужны хук клиента и событие ленты').toEqual([]);
  });
});

describe('виды источников — одни в коде и в схеме', () => {
  // Проверка заведена в 1195 и расширяется следующими миграциями (1349 —
  // заявка на жильё): судит ПОСЛЕДНЯЯ по номеру, где она объявлена.
  const migrations = readdirSync(join(ROOT, 'migrations'))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const listOf = (constraint: string): string[] => {
    let last: string[] | null = null;
    for (const f of migrations) {
      const sql = readFileSync(join(ROOT, 'migrations', f), 'utf8');
      const m = new RegExp(`CONSTRAINT ${constraint} CHECK \\([a-z_]+ IN \\(([^)]*)\\)`).exec(sql);
      if (m) last = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    }
    if (!last) throw new Error(`${constraint} не найден в миграциях`);
    return last;
  };

  it('CHECK вида связи совпадает с SOURCE_KINDS', () => {
    expect(listOf('crm_contact_links_kind_check')).toEqual([...SOURCE_KINDS].sort());
  });

  it('CHECK происхождения — те же виды плюс ручной контакт', () => {
    expect(listOf('crm_contacts_origin_check')).toEqual([...SOURCE_KINDS, 'manual'].sort());
  });
});
