/**
 * Туры «Края Вулканов» (миграция 1176, #2245) с витрины оператора.
 *
 * Сторож держит обещания шапки миграции: 11 туров на карточку 1174,
 * опубликованы (цены подтверждены оператором 08.10 «такие же на 2027 год» —
 * первая редакция заводила черновики), цена за человека (иначе ступени 1173
 * не работают),
 * ступени дословно с витрины, ничего не выдумано (нет дат, нет «что взять»,
 * нет условий отмены, нет фото), спорная цена тура 07 не перенесена,
 * вставка идемпотентна, id сравниваются текстом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/1176_volcanoesland_tours.sql'), 'utf-8');
/** Исполняемая часть без комментариев: шапка вправе упоминать то, чего в коде быть не должно. */
const CODE = SQL.replace(/--[^\n]*/g, '');

/** Ступени с витрины (комментарий владельца в #2245 от 06.10 и проба 712). */
const SITE_TIERS: Array<[string, number, number | null, number]> = [
  ['volcanoesland-ploskiy-tolbachik', 10, null, 60000],
  ['volcanoesland-oblet-klyuchevskoy-gruppy-dolina-geyzerov', 6, 8, 520000],
  ['volcanoesland-oblet-klyuchevskoy-gruppy-dolina-geyzerov', 9, null, 410000],
  ['volcanoesland-splav-bystraya-gorelyy-avachinskiy', 6, 8, 140000],
  ['volcanoesland-splav-bystraya-gorelyy-avachinskiy', 9, null, 115000],
  ['volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo', 6, 8, 370000],
  ['volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo', 9, null, 260000],
  ['volcanoesland-treking-podnozhie-klyuchevskoy', 6, 8, 230000],
  ['volcanoesland-treking-podnozhie-klyuchevskoy', 9, null, 180000],
  ['volcanoesland-treking-vokrug-ploskogo-tolbachika', 9, null, 180000],
  ['volcanoesland-voskhozhdenie-klyuchevskaya-sopka', 6, null, 320000],
  ['volcanoesland-avtotur-kurilskoe-ozero', 6, 8, 170000],
  ['volcanoesland-avtotur-kurilskoe-ozero', 9, null, 150000],
];

const SLUGS = [
  'volcanoesland-kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha',
  'volcanoesland-ploskiy-tolbachik',
  'volcanoesland-oblet-klyuchevskoy-gruppy-dolina-geyzerov',
  'volcanoesland-splav-bystraya-gorelyy-avachinskiy',
  'volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo',
  'volcanoesland-treking-podnozhie-klyuchevskoy',
  'volcanoesland-treking-vokrug-ploskogo-tolbachika',
  'volcanoesland-voskhozhdenie-klyuchevskaya-sopka',
  'volcanoesland-kruiz-komandorskie-ostrova',
  'volcanoesland-dolina-geyzerov-kaldera-uzon',
  'volcanoesland-avtotur-kurilskoe-ozero',
];

/** Строки VALUES первого INSERT — по одной на тур. */
function tourRows(): string[] {
  const body = SQL.slice(SQL.indexOf('CROSS JOIN (VALUES'), SQL.indexOf(') AS v(title, slug'));
  return body.split(/\n  \(/).slice(1);
}

describe('миграция 1176: туры «Края Вулканов»', () => {
  it('11 туров на карточку по slug партнёра, опубликованы с подтверждением цен на 2027, цена за человека', () => {
    const rows = tourRows();
    expect(rows).toHaveLength(11);
    for (const s of SLUGS) expect(SQL, s).toContain(`'${s}'`);
    expect(SQL).toMatch(/WHERE p\.slug = 'volcanoesland'/);
    expect(SQL).toMatch(/TRUE, v\.diff, TRUE, TRUE,/); // weather_dependent, difficulty, is_active, is_published
    expect(SQL).toMatch(/цены такие же[\s-]+на 2027 год/);
    for (const row of tourRows()) expect(row, row.slice(0, 60)).toContain('Цены подтверждены оператором на сезон 2027 года.');
    expect(SQL).toMatch(/v\.price, 'RUB', 'per_person'/);
    expect(SQL).toMatch(/11 THEN/);
  });

  it('ступени — дословно с витрины, и ни одной сверх того', () => {
    const block = SQL.slice(SQL.indexOf('INSERT INTO tour_price_tiers'), SQL.indexOf('DO $$'));
    const found = [...block.matchAll(/\('([a-z0-9-]+)', (\d+), (\d+|NULL), (\d+)::numeric\)/g)]
      .map((m) => [m[1], Number(m[2]), m[3] === 'NULL' ? null : Number(m[3]), Number(m[4])]);
    expect(found).toEqual(SITE_TIERS);
    // Спорная цена тура 07 («120 000 при группе от 6» ниже цены за 9) не перенесена.
    expect(block).not.toMatch(/treking-vokrug-ploskogo-tolbachika', 6,/);
    expect(SQL).toMatch(/120 000 ₽ при группе от 6 человек — до подтверждения оператором не переносится/);
  });

  it('ничего не выдумано: нет дат, фото, «что взять» и условий отмены; описания не короче 300', () => {
    expect(CODE).not.toMatch(/season_start|season_end|tour_availability/);
    expect(CODE).not.toMatch(/\d{2}\.\d{2}\.202\d/);
    expect(CODE).not.toMatch(/\bphotos\b|tour_image/);
    expect(CODE).not.toMatch(/what_to_bring/);
    expect(CODE).not.toMatch(/cancellation_policy|cancellation_free_days/);
    for (const row of tourRows()) {
      const descr = row.split('\n')[1];
      expect(descr.length, row.slice(0, 60)).toBeGreaterThan(300);
    }
    expect(SQL).toMatch(/source_url/);
    expect((SQL.match(/https:\/\/volcanoesland\.ru\/tours\/[a-z0-9-]+\//g) ?? []).length).toBe(11);
  });

  it('идемпотентна и сравнивает id текстом', () => {
    expect(SQL).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM operator_tours t\s+WHERE t\.operator_id::text = p\.id::text AND t\.slug = v\.slug/);
    expect(SQL).toMatch(/x\.operator_tour_id::text = t\.id::text AND x\.min_people = v\.min_people/);
    expect(SQL).not.toMatch(/INSERT INTO partners|INSERT INTO users/);
  });

  it('программа по дням: у многодневных туров дней в программе столько же, сколько в multi_day_count', () => {
    for (const row of tourRows()) {
      const m = /::numeric, '(multi_day|day)', (\d+|NULL),/.exec(row)!;
      const program = /'\[(.*)\]'::jsonb/s.exec(row)![1];
      const days = (program.match(/""title"":|"title":/g) ?? []).length;
      if (m[1] === 'multi_day') expect(days, row.slice(0, 60)).toBe(Number(m[2]));
      expect(program).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
