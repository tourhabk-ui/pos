/**
 * Выгрузки кабинета оператора (аудит, пакет «Г», п.6).
 *
 * 1. Формульная инъекция: имя/телефон туриста пишет посторонний человек, и
 *    значение с `=`/`+`/`-`/`@`/таб/CR в начале Excel исполняет как формулу.
 * 2. Финансовый отчёт не считает отменённые брони выручкой и берёт
 *    зафиксированную комиссию (operator_commissions), текущую ставку — только
 *    как оценку там, где начисления нет, и говорит, сколько таких.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { csvCell, toCSV } from '@/lib/operator/csv';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('CSV: формула становится текстом', () => {
  for (const evil of ['=HYPERLINK("http://x","y")', '+7 900', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    it(`«${JSON.stringify(evil)}» начинается с апострофа`, () => {
      const cell = csvCell(evil);
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(evil);
    });
  }

  it('обычное значение не меняется, разделитель и кавычки экранируются', () => {
    expect(csvCell('Иван')).toBe('Иван');
    expect(csvCell(12500)).toBe('12500');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
  });

  it('toCSV прогоняет через защиту каждую ячейку', () => {
    const csv = toCSV([{ client: '=cmd|calc', phone: '+7' }], { client: 'Клиент', phone: 'Телефон' });
    expect(csv.split('\n')[1]).toBe("'=cmd|calc;'+7");
  });

  it('отчёты оператора пользуются общей функцией, своей копии нет', () => {
    const src = read('app/api/hub/operator/reports/route.ts');
    expect(src).toMatch(/import \{ toCSV \} from '@\/lib\/operator\/csv'/);
    expect(src).not.toMatch(/function toCSV\(/);
  });
});

describe('финансовый отчёт', () => {
  const src = read('app/api/hub/operator/reports/route.ts');
  const finance = src.slice(src.indexOf("type === 'finance'"), src.indexOf("type === 'clients'"));

  it('отменённые брони исключены тем же списком, что гейтит выплату', () => {
    expect(finance).toMatch(/ob\.booking_status <> ALL\(\$2::text\[\]\)/);
    expect(finance).toMatch(/CANCELLED_STATUS_PARAM/);
    expect(finance).toMatch(/ob\.payment_status = 'paid'/);
  });

  it('комиссия — зафиксированная при оплате, текущая ставка только запасом', () => {
    expect(finance).toMatch(/FROM operator_commissions c/);
    expect(finance).toMatch(/COALESCE\(oc\.amount, ob\.final_price \* COALESCE\(p\.commission_current, \$3\) \/ 100\)/);
    // Сколько посчитано по текущей ставке, отчёт говорит сам.
    expect(finance).toMatch(/fee_estimated_bookings/);
  });
});
