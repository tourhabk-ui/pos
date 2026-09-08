/**
 * tests/unit/refusal-detector.test.ts
 *
 * Отказ модели — отдельный исход, а не отсутствие ответа (issue #1730).
 *
 * Оценка ответа Кузьмича пропускала всё короче 50 знаков: порог заводился
 * против обрывов связи, и для них он верен. Но отказ короток по природе — «не
 * могу помочь с этим вопросом» меньше пятидесяти, — и порог глотал его
 * целиком: ни балла, ни записи, ни следа. Отказ был неотличим от того, что
 * ответа не было.
 *
 * Для советника по безопасности это дорого именно темами: законные вопросы про
 * медведя рядом, фальшфейер, травму и переохлаждение лежат ровно там, где
 * модели отказывают темой целиком. Своего списка запретных тем у платформы
 * нет — отказ выносит провайдер, а водопад меняет провайдера молча.
 *
 * Сторож держит границу детектора с двух сторон: отказ узнаётся, а правильные
 * ответы — правила места и честное «не знаю» — отказом НЕ считаются.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectRefusal } from '@/lib/safety/refusal-detector';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('отказ узнаётся', () => {
  const REFUSALS = [
    'Извините, я не могу помочь с этим вопросом.',
    'Не могу обсуждать эту тему.',
    'Это выходит за рамки моей роли.',
    'Как ИИ я не могу давать такие советы.',
    "I can't help with that request.",
    'As an AI, I cannot provide this information.',
  ];

  for (const text of REFUSALS) {
    it(`«${text.slice(0, 40)}…»`, () => {
      const r = detectRefusal(text);
      expect(r.refused, 'отказ не распознан — он снова провалится в порог').toBe(true);
      expect(r.markers.length, 'вердикт без улики неразбираем').toBeGreaterThan(0);
    });
  }

  it('короче порога оценки — именно тот случай, ради которого детектор', () => {
    const short = 'Не могу помочь с этим.';
    expect(short.length).toBeLessThan(50);
    expect(detectRefusal(short).refused).toBe(true);
  });
});

describe('правильный ответ отказом не считается', () => {
  const NOT_REFUSALS = [
    // Честное «не знаю» промпт ТРЕБУЕТ: считать его отказом значило бы
    // штрафовать за выполнение правила.
    'У меня нет подтверждённой информации об этом событии.',
    'Этого нет в моих данных, уточни у МЧС по телефону 112.',
    // Правило места, а не отказ отвечать.
    'В природном парке нельзя разводить костёр вне оборудованных мест.',
    'На этот маршрут без гида идти нельзя — нужна регистрация в МЧС.',
    // Обычный содержательный ответ про ту самую «острую» тему.
    'Фальшфейер держи в кармане куртки, а не в рюкзаке: доставать надо за секунды.',
    'Медведь на тропе — не беги. Говори громко, отходи боком, не поворачивайся спиной.',
  ];

  for (const text of NOT_REFUSALS) {
    it(`«${text.slice(0, 45)}…»`, () => {
      expect(detectRefusal(text).refused, 'правильный ответ помечен отказом').toBe(false);
    });
  }

  it('пустой ответ — не отказ: это обрыв, у него своя причина', () => {
    expect(detectRefusal('').refused).toBe(false);
    expect(detectRefusal('   ').refused).toBe(false);
  });
});

describe('врезка в оценку', () => {
  const OUTCOMES = code(read('lib/agents/managed/kuzmich-outcomes.ts'));

  it('порог не глотает отказ', () => {
    expect(OUTCOMES).toMatch(/botResponse\.length < 50 && !refusal\.refused/);
  });

  it('отказ не судится моделью — балл 0 с явной причиной', () => {
    // Судья поставил бы низкий балл за бесполезность и записал это как
    // качество ответа, тогда как причина другая: провайдер не стал отвечать.
    expect(OUTCOMES).toMatch(/if \(refusal\.refused\)/);
    expect(OUTCOMES).toMatch(/ОТКАЗ МОДЕЛИ/);
    expect(OUTCOMES).toMatch(/score: 0/);
  });

  it('запись исхода одна на оба пути — своя копия разошлась бы', () => {
    expect(OUTCOMES).toMatch(/async function saveOutcome/);
    // Ровно одна вставка в agent_knowledge на весь модуль.
    expect((OUTCOMES.match(/INSERT INTO agent_knowledge/g) ?? []).length).toBe(1);
  });

  it('отказ попадает в metadata вместе с уликами и провайдером', () => {
    expect(OUTCOMES).toMatch(/refused:\s+refusal\.refused/);
    expect(OUTCOMES).toMatch(/refusal_markers/);
    expect(OUTCOMES).toMatch(/provider:\s+opts\?\.provider \?\? null/);
  });

  it('в сводке отказы считаются отдельно от низких баллов', () => {
    // Низкий балл значит «ответили плохо», отказ — «не стали отвечать»,
    // и чинятся они в разных местах.
    expect(OUTCOMES).toMatch(/refused_count/);
    expect(OUTCOMES).toMatch(/refusals_by_provider/);
    // Считается по metadata, а не по тексту судьи: детерминированному
    // детектору верить надёжнее, чем формулировке модели.
    expect(OUTCOMES).toMatch(/metadata->>'refused' = 'true'/);
  });
});
