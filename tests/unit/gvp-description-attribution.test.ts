/**
 * Подпись источника под описанием места (#1830, шаг 4).
 *
 * 13.09 в `places.description` легли 23 текста, переведённых с Remarks
 * Смитсоновского института. Владелец потребовал видимую пометку: научный
 * источник отвечает за содержание, мы — только за перевод, и человеку это
 * различие нужно видеть там, где он читает.
 *
 * ЧТО СТОРОЖ ДЕРЖИТ И ПОЧЕМУ ИМЕННО ЭТО.
 *
 * 1. **Подпись привязана к ТЕКСТУ, а не к месту.** `places.source_url` /
 *    `source_name` говорят о происхождении ЗАПИСИ и на экран не выводятся
 *    намеренно (решение владельца 17.08, §4.1). Здесь другое поле и другой
 *    смысл; смешать их значило бы вернуть на экран то, что оттуда убрали.
 *
 * 2. **Равенство текстов в JOIN.** Черновик остаётся `approved` навсегда, а
 *    описание потом может переписать кто угодно — Editor, миграция, человек в
 *    админке. Подпись «по данным Смитсоновского института» под чужим текстом
 *    — ложное утверждение об источнике, и хуже отсутствия подписи. Условие
 *    `translated_text = p.description` снимает подпись САМО, без чьей-либо
 *    памяти о том, что так надо.
 *
 * 3. **Ссылки нет, и это записано как «не смог».** Проба 499 (13.09) получила
 *    HTTP 403 на все три адреса volcano.si.edu и si.edu — Смитсоновский
 *    закрывает датацентр. Формат адреса ПРОВЕРИТЬ НЕ УДАЛОСЬ; это третий
 *    исход (§4.0), а не «ссылка не нужна». Непроверенный путь на карточке был
 *    бы обещанием дороги, которой мы не видели.
 *
 * 4. **Формулировка одна на платформу.** Две подписи под одним источником
 *    стали бы двумя разными утверждениями о нём — тот же урок, что у линий
 *    карты (§12) и у подсказки избранного.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDescriptionSource } from '@/lib/text/description-source';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const API = read('app/api/places/[id]/route.ts');
const MODULE = read('lib/text/description-source.ts');
const VIEW = read('components/places/PlaceDescription.tsx');
const CLIENT = read('app/places/[id]/_PlaceDetailClient.tsx');

describe('describeDescriptionSource — чистая логика', () => {
  it('нет ссылки на черновик — нет подписи', () => {
    expect(describeDescriptionSource(null)).toBeNull();
    expect(describeDescriptionSource(undefined)).toBeNull();
    expect(describeDescriptionSource('')).toBeNull();
  });

  it('есть VolcanoNumber — подпись дословно из issue', () => {
    const src = describeDescriptionSource('300270');
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('gvp');
    expect(src!.label).toBe('По данным Global Volcanism Program, Смитсоновский институт');
  });

  it('полное имя института, не аббревиатура', () => {
    // «ГВП» человеку в поле не говорит ничего, а подпись ставится ради него.
    const src = describeDescriptionSource('300270')!;
    expect(src.label).toContain('Смитсоновский институт');
    expect(src.label).not.toMatch(/\bГВП\b/);
  });

  it('ссылки в контракте нет вовсе — а не поле, всегда равное null', () => {
    // Поле, которое никогда не заполняется, — то же объявление без источника
    // (§10.09). Пока адрес не проверен, ссылки нет и в типе.
    const src = describeDescriptionSource('300270')!;
    expect('url' in src).toBe(false);
    expect(MODULE).not.toMatch(/https:\/\/volcano\.si\.edu\/volcano\.cfm/);
  });

  it('причина отсутствия ссылки записана, а не подразумевается', () => {
    expect(MODULE).toMatch(/403/);
    expect(MODULE).toMatch(/ПРОВЕРИТЬ НЕ УДАЛОСЬ/);
  });
});

describe('API отдаёт подпись только пока текст не разошёлся с переводом', () => {
  it('JOIN требует approved-черновик ГВП И посимвольное совпадение', () => {
    const at = API.indexOf('LEFT JOIN place_description_drafts gvp');
    expect(at, 'JOIN черновика не найден').toBeGreaterThan(-1);
    const join = API.slice(at, at + 400);
    expect(join).toContain("gvp.source = 'gvp'");
    expect(join).toContain("gvp.status = 'approved'");
    expect(join, 'без сравнения текстов подпись переживёт переписанное описание')
      .toContain('gvp.translated_text = p.description');
  });

  it('в ответе отдельное поле, не смешанное с источником ЗАПИСИ места', () => {
    expect(API).toMatch(/descriptionSource: describeDescriptionSource\(r\.description_source_ref/);
    // Источник записи остаётся как был — своим полем и своим смыслом.
    expect(API).toMatch(/sourceName: r\.source_name/);
  });
});

describe('подпись доходит до экрана', () => {
  it('карточка передаёт её в блок описания', () => {
    expect(CLIENT).toMatch(/descriptionSource=\{place\.descriptionSource\}/);
  });

  it('рисуется под текстом, которому относится, и только при наличии', () => {
    expect(VIEW).toMatch(/\{descriptionSource && \(/);
    expect(VIEW).toMatch(/\{descriptionSource\.label\}/);
    // Приглушённо: это сноска, а не часть рассказа о месте.
    expect(VIEW).toMatch(/text-\[var\(--text-muted\)\]/);
  });

  it('подпись — не ссылка: непроверенный адрес наружу не идёт', () => {
    const at = VIEW.indexOf('descriptionSource.label');
    const block = VIEW.slice(Math.max(0, at - 400), at + 200);
    expect(block).not.toMatch(/<a\s/);
    expect(block).not.toContain('volcano.si.edu');
  });
});
