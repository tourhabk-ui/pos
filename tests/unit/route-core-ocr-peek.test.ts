/**
 * Заглянуть в OCR-markdown паспорта прежде, чем строить парсер трека.
 * Индикатор координат — не парсер: он только отвечает «стоит ли пробовать».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/route-core-ocr-peek/route.ts'), 'utf-8');

describe('только читает, id явные', () => {
  it('ни одного изменяющего запроса', () => {
    expect(SRC).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('id передаются явно, роут не гадает состав ядра', () => {
    expect(SRC).toContain("searchParams.get('ids')");
  });
});

describe('третье состояние: OCR не прошёл — не то же самое, что «в паспорте пусто»', () => {
  it('ocr_missing называет id, для которых нет строки в route_passport_ocr', () => {
    expect(SRC).toContain('ocr_missing');
    expect(SRC).toMatch(/!rows\.some\(\(r\) => r\.route_id === id\)/);
  });
});

describe('индикатор, а не парсер', () => {
  it('coordLike — только сигнал, не извлечение и не запись координат', () => {
    expect(SRC).toContain('looks_like_has_coordinates');
    expect(SRC).not.toMatch(/geometry\s*=|route_waypoints/);
  });
});
