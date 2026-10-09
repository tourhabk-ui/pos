/**
 * Сторож: у каждого источника клиента есть производитель (CRM #2325, правило
 * 10.09 «объявленный исход без источника»).
 *
 * Клиент партнёра заводится хуком `linkContactQuietly` там, где создаётся
 * строка источника. Новая дверь брони, заказа или лида без хука — это клиент,
 * которого партнёр не увидит, пока кто-нибудь не вспомнит позвать задел. Тест
 * находит двери ПО КОДУ: любой файл с `INSERT INTO` в одну из шести таблиц
 * обязан звать хук своего вида после вставки — либо стоять в
 * `KNOWN_WITHOUT_HOOK` с причиной. Список самоустаревающий: дверь пропала —
 * запись требует убрать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SOURCE_KINDS, type SourceKind } from '@/lib/crm/contacts';

const ROOT = process.cwd();

const TABLE_KIND: Readonly<Record<string, SourceKind>> = {
  operator_bookings: 'operator_booking',
  accommodation_bookings: 'accommodation_booking',
  gear_rentals: 'gear_rental',
  transfer_seat_bookings: 'transfer_seat_booking',
  leads: 'lead',
  agent_clients: 'agent_client',
};

const KNOWN_WITHOUT_HOOK: Readonly<Record<string, string>> = {
  'lib/services/tours/booking.service.ts':
    'мёртвая дверь: bookingService.create не зовёт никто — экспорт есть, потребителя нет (проверяется ниже)',
  'app/api/cron/payment-test-setup/route.ts':
    'проба оплаты: тестовая бронь не клиент оператора',
  'app/api/cron/sql-shape-check/route.ts':
    'только PREPARE: вывод типов на разборе, ни одна строка не вставляется',
};

const INSERT_RE = new RegExp(
  String.raw`INSERT\s+INTO\s+(?:public\.)?(${Object.keys(TABLE_KIND).join('|')})\b`,
  'g',
);

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
    const matches = [...src.matchAll(INSERT_RE)];
    if (matches.length === 0) continue;
    found.set(relative(ROOT, abs), {
      src,
      tables: new Set(matches.map((m) => m[1])),
      firstInsert: Math.min(...matches.map((m) => m.index ?? 0)),
    });
  }
  return found;
}

describe('у каждой двери источника есть хук клиента', () => {
  const all = inserters();

  it('перепись находит двери (иначе сторож пуст и зелен по ошибке)', () => {
    // Шесть видов, у каждого хотя бы одна дверь с хуком.
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

  it('мёртвая дверь bookingService.create по-прежнему без потребителей', () => {
    const users = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'components'))]
      .map((abs) => relative(ROOT, abs))
      .filter((rel) => rel !== 'lib/services/tours/booking.service.ts' && rel !== 'lib/services/index.ts')
      .filter((rel) => /\bbookingService\b/.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(users, 'bookingService начали звать — дверь ожила, ей нужен хук linkContactQuietly').toEqual([]);
  });
});

describe('виды источников — одни в коде и в схеме', () => {
  const sql = readFileSync(join(ROOT, 'migrations', '1195_crm_contacts.sql'), 'utf8');
  const listOf = (constraint: string): string[] => {
    const m = new RegExp(`CONSTRAINT ${constraint} CHECK \\([a-z_]+ IN \\(([^)]*)\\)`).exec(sql);
    if (!m) throw new Error(`${constraint} не найден в миграции`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };

  it('CHECK вида связи совпадает с SOURCE_KINDS', () => {
    expect(listOf('crm_contact_links_kind_check')).toEqual([...SOURCE_KINDS].sort());
  });

  it('CHECK происхождения — те же виды плюс ручной контакт', () => {
    expect(listOf('crm_contacts_origin_check')).toEqual([...SOURCE_KINDS, 'manual'].sort());
  });
});
