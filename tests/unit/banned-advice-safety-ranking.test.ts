/**
 * Запрет выдуманной оценки безопасности способа или тура — формы, которые
 * правило 17.11 пропускало (#3494, задача 28.11, ошибка 3).
 *
 * Набор фраз 1–9 задан задачей и не пересматривается: 1–5 — оценка, её нет ни
 * в одной сводке Ведара, предложение вырезается; 6–9 — осторожный совет или
 * отрицание, они остаются. Судится поведение: `hasSafetyRanking`, живой
 * вырез `stripBannedAdvice` и проверка эвала `no_safety_ranking` — на тех же
 * строках.
 */
import { describe, it, expect } from 'vitest';
import { hasSafetyRanking, stripBannedAdvice } from '@/lib/kuzmich/banned-advice';
import { judgeCommercial, referenceKey, type ReferenceResult } from '@/lib/agents/eval/commercial-checks';

const CUT = [
  'Безопаснее всего увидеть Толбачик с вертолёта.',
  'Только вертолётом туда можно добраться безопасно.',
  'Облёт — самый надёжный и безопасный способ.',
  'Самым безопасным будет вертолётный тур.',
  'Самый безопасный из туров — облёт.',
];

const KEEP = [
  'Самый безопасный вариант — отложить поход.',
  'Безопаснее всего сейчас — остаться в укрытии и звонить 112.',
  'Это не самый безопасный способ, лучше с гидом.',
  'Безопаснее всего — дождаться, пока откроют дорогу.',
];

/** Фразы, которые правило 17.11 уже вырезало: правка их не теряет. */
const CUT_BEFORE = [
  'Вертолётный облёт — пока единственный безопасный способ увидеть Толбачик.',
  'Самый безопасный вариант — вертолётный облёт.',
  'Это наиболее безопасный тур из всех.',
];

const PARK = 'Природный парк «Ключевской» сейчас закрыт на зимний сезон.';

describe('новые формы оценки вырезаются', () => {
  it.each(CUT)('%s', (phrase) => {
    expect(hasSafetyRanking(phrase)).toBe(true);
    const r = stripBannedAdvice(`${PARK} ${phrase} Рассказать про программу?`);
    expect(r.ranking).toEqual([phrase]);
    expect(r.text).toBe(`${PARK} Рассказать про программу?`);
  });
});

describe('осторожный совет и отрицание остаются', () => {
  it.each(KEEP)('%s', (phrase) => {
    expect(hasSafetyRanking(phrase)).toBe(false);
    expect(stripBannedAdvice(phrase)).toMatchObject({ text: phrase, ranking: [] });
  });

  it('закрытый список «только …»: «только с гидом … безопасно» — совет', () => {
    const phrase = 'Только с гидом туда можно пройти безопасно.';
    expect(hasSafetyRanking(phrase)).toBe(false);
  });

  it('у «безопаснее всего» и «самым безопасным будет» совет без тире тоже остаётся', () => {
    for (const phrase of ['Безопаснее всего остаться в укрытии до утра.', 'Самым безопасным будет отложить поход.']) {
      expect(hasSafetyRanking(phrase), phrase).toBe(false);
    }
  });
});

describe('прежние формы по-прежнему вырезаются', () => {
  it.each(CUT_BEFORE)('%s', (phrase) => expect(hasSafetyRanking(phrase)).toBe(true));
});

describe('эвал судит те же строки', () => {
  const refs = new Map<string, ReferenceResult>([[referenceKey(''), { ok: true, text: 'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:' }]]);
  const verdict = (answer: string) =>
    judgeCommercial({ question: 'Как безопаснее увидеть Толбачик?', answer, context: '', checks: [], references: refs }).checks.find(
      (c) => c.kind === 'no_safety_ranking',
    );

  it.each(CUT)('провал: %s', (phrase) => {
    const v = verdict(`${PARK} ${phrase}`);
    expect(v?.outcome).toBe('fail');
    expect(v?.reason).toBe('оценка безопасности способа или тура без данных Ведара');
  });

  it.each(KEEP)('проходит: %s', (phrase) => expect(verdict(`${PARK} ${phrase}`)?.outcome).toBe('pass'));
});
