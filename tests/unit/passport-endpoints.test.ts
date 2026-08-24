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

  it('дата в тексте (23.06.2023) не читается как координатная пара', () => {
    expect(parseDms('Приказ № 53-П от 23.06.2023 г.')).toBeNull();
  });

  it('дистанция маршрута («5 км») не читается как координата', () => {
    expect(parseDms('5 км (в обе стороны)')).toBeNull();
  });
});

describe('parseDms: реальные форматы из 20 паспортов ядра Ф5 (проба 199, 24.08)', () => {
  it('DMS, полушарие ПЕРЕД, кавычка-секунда (N55°44\'07" E160°18\'55") — «Вокруг Толбачиков»', () => {
    const r = parseDms(`N55°44'07" E160°18'55"`);
    expect(r!.lat).toBeCloseTo(55.7353, 3);
    expect(r!.lng).toBeCloseTo(160.3153, 3);
  });

  it('DMS, полушарие ПЕРЕД (N53°16\'02" E158°30\'10") — «5 стройка–Центральный»', () => {
    const r = parseDms(`N53°16'02" E158°30'10"`);
    expect(r!.lat).toBeCloseTo(53.2672, 3);
    expect(r!.lng).toBeCloseTo(158.5028, 3);
  });

  it('DDM без секунд, полушарие ПЕРЕД (N53°10.51\' E157°54.74\') — «Вачкажец снегоходный»', () => {
    const r = parseDms(`N53°10.51' E157°54.74'`);
    expect(r!.lat).toBeCloseTo(53.1752, 3);
    expect(r!.lng).toBeCloseTo(157.9123, 3);
  });

  it('decimal с кириллической подписью полушария («54,4362056 С.Ш., 160,136006 В.Д.») — «Гейзеры Кроноцкого»', () => {
    const r = parseDms('54,4362056 С.Ш., 160,136006 В.Д.');
    expect(r).toEqual({ lat: 54.4362056, lng: 160.136006 });
  });

  it('голый decimal через точку с запятой («54,4674322; 160,18883») — «Долина Смерти»', () => {
    const r = parseDms('54,4674322; 160,18883');
    expect(r).toEqual({ lat: 54.4674322, lng: 160.18883 });
  });

  it('суффиксная буква первой координаты не перехватывается как префикс второй (пробел между ними)', () => {
    // Прежняя версия парсера теряла обе координаты именно на этой строке:
    // «...26'N 158°...» читалось как «N 158°...» — суффикс первой ошибочно
    // становился префиксом второй через пробел.
    const r = parseDms(`52°50'26'N 158°09'06'E`);
    expect(r!.lat).toBeCloseTo(52.8406, 3);
    expect(r!.lng).toBeCloseTo(158.1517, 3);
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
