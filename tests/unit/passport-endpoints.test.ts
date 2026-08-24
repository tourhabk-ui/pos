/**
 * Извлечение точек начала/конца из паспорта: чистые функции, никакой БД.
 *
 * Ключевая дисциплина: координату переводит из DMS КОД, не модель — LLM
 * отдаёт дословную цитату, арифметику делает parseDms. Молчание («не знаю»)
 * лучше угаданной координаты (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { parseDms, parsePassportEndpoints } from '@/lib/routes/passport-endpoints';

describe('parseDms: реальные и синтетические случаи', () => {
  it('реальная строка из паспорта «Бабий камень» (OCR, апостроф вместо кавычки-секунды)', () => {
    const r = parseDms(`52°50'26'N 158°09'06'E`);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(52.8406, 3);
    expect(r!.lng).toBeCloseTo(158.1517, 3);
  });

  it('та же строка с правильной кавычкой-секундой тоже разбирается', () => {
    const r = parseDms(`52°50'26"N 158°09'06"E`);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(52.8406, 3);
  });

  it('южное и западное полушарие дают отрицательный знак', () => {
    const r = parseDms(`10°00'00"S 20°00'00"W`);
    expect(r!.lat).toBeLessThan(0);
    expect(r!.lng).toBeLessThan(0);
  });

  it('decimal-формат "lat, lng" тоже разбирается', () => {
    const r = parseDms('52.963036, 158.708946');
    expect(r).toEqual({ lat: 52.963036, lng: 158.708946 });
  });

  it('null, пустая строка и текст без координаты дают null, не 0', () => {
    expect(parseDms(null)).toBeNull();
    expect(parseDms('')).toBeNull();
    expect(parseDms('Кордон «Авачинский»')).toBeNull();
    expect(parseDms('нет данных')).toBeNull();
  });

  it('обрывок DMS без хотя бы одной координаты не даёт частичного результата', () => {
    expect(parseDms(`52°50'26"N`)).toBeNull();
  });
});

describe('parsePassportEndpoints: терпимый разбор ответа модели', () => {
  it('полный ответ разбирается', () => {
    const raw = JSON.stringify({
      start: { name: 'Кордон «Авачинский»', coord_text: null },
      end: { name: 'Кордон «Центральный»', coord_text: null },
    });
    const r = parsePassportEndpoints(raw);
    expect(r).toEqual({
      start: { name: 'Кордон «Авачинский»', coord_text: null },
      end: { name: 'Кордон «Центральный»', coord_text: null },
    });
  });

  it('координата приходит дословной строкой, не числом', () => {
    const raw = JSON.stringify({
      start: { name: null, coord_text: `52°50'26'N 158°09'06'E` },
      end: { name: null, coord_text: `52°50'26'N 158°09'06'E` },
    });
    const r = parsePassportEndpoints(raw);
    expect(r!.start.coord_text).toBe(`52°50'26'N 158°09'06'E`);
  });

  it('JSON в markdown-обрамлении разбирается', () => {
    const raw = '```json\n' + JSON.stringify({
      start: { name: null, coord_text: null },
      end: { name: null, coord_text: null },
    }) + '\n```';
    expect(parsePassportEndpoints(raw)).not.toBeNull();
  });

  it('мусор без JSON даёт null, а не выброшенное исключение', () => {
    expect(parsePassportEndpoints('извините, не нашёл данных')).toBeNull();
  });

  it('отсутствующие start/end становятся объектом с null-полями, не падают', () => {
    const r = parsePassportEndpoints('{}');
    expect(r).toEqual({
      start: { name: null, coord_text: null },
      end: { name: null, coord_text: null },
    });
  });

  it('не число и не строка в name/coord_text — null, не выдумка', () => {
    const raw = JSON.stringify({ start: { name: 42, coord_text: true }, end: {} });
    const r = parsePassportEndpoints(raw);
    expect(r!.start).toEqual({ name: null, coord_text: null });
  });
});
