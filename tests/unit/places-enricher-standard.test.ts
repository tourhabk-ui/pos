/**
 * Сторож: второй писатель описаний живёт по тем же правилам, что первый.
 *
 * Находка аудита 08.09: описания мест пишут двое — Editor и обогатитель, — и
 * второй делал ту же работу по худшим правилам: гонка мелких моделей вместо
 * качественного водопада, ни строки происхождения, своя мерка сходства имён
 * (`includes` → 0.85 при пороге 0.65) и заглушённый отказ каждого скрейпера.
 *
 * Цена самой опасной из них — не опрятность. Чужой текст на карточке места
 * читается туристом как правда о местности, по которой он пойдёт, и отличить
 * подмену ему нечем: описание связное и уверенное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bidirectionalNameScore, NAME_MATCH_MIN } from '@/lib/agents/places-enricher';

const src = readFileSync(join(process.cwd(), 'lib/agents/places-enricher.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('сходство имён: мерка общая и в обе стороны', () => {
  it('одно и то же место под разными родовыми словами — совпадение', () => {
    expect(bidirectionalNameScore('Ключевская сопка', 'Ключевской вулкан')).toBe(1);
    expect(bidirectionalNameScore('Вачкажец', 'Горный массив Вачкажец')).toBe(1);
  });

  it('разные объекты не совпадают, даже если род общий', () => {
    expect(bidirectionalNameScore('Долина гейзеров', 'Долина смерти')).toBeLessThan(NAME_MATCH_MIN);
    expect(bidirectionalNameScore('Малкинские источники', 'Паратунские источники')).toBeLessThan(NAME_MATCH_MIN);
  });

  it('одностороннего совпадения мало', () => {
    // «Курильское озеро» целиком лежит внутри «Курильское озеро и Кутхины
    // баты»: направленная мерка сказала бы «то самое», и месту достался бы
    // текст про два объекта сразу.
    const oneWay = bidirectionalNameScore('Курильское озеро', 'Курильское озеро и Кутхины баты');
    expect(oneWay).toBeLessThan(NAME_MATCH_MIN);
  });

  it('своей мерки в файле не осталось', () => {
    expect(code, 'вернулась своя функция сходства').not.toMatch(/function titleSimilarity/);
    expect(code, 'вернулся includes → 0.85').not.toMatch(/includes\(nb\)/);
    expect(code, 'вернулся порог 0.65').not.toMatch(/0\.65/);
    expect(code).toMatch(/nameMatchScore/);
  });
});

describe('описание пишется по правилам первого писателя', () => {
  it('качественный водопад, а не гонка мелких моделей', () => {
    expect(code, 'гонка callAIFast для текста, который читают люди').not.toMatch(/callAIFast/);
    expect(code).toMatch(/callAIQualityOrNull/);
    expect(code, 'ответ-заглушка водопада может уйти в описание').toMatch(/isWaterfallErrorResponse/);
  });

  it('происхождение записывается вместе с адресом источника', () => {
    expect(code).toMatch(/INSERT INTO description_provenance/);
    expect(code).toMatch(/'places-enricher'/);
    expect(code).toMatch(/sourceUrl/);
  });

  it('отказ источника называет, кто не ответил', () => {
    expect(code, 'отказ скрейпера снова заглушён').not.toMatch(/\}\s*catch\s*\{\s*\}/);
    expect(code).toMatch(/logSwallowedFailure\('places-enricher'/);
  });
});
