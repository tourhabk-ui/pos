/**
 * Шаблон «Туры из каталога» говорит, по каким признакам вопроса он не отбирал
 * (#3179, п. 6, оценка вместо судьи 19.11).
 *
 * Было: на «семейный тур с детьми» — одна рыболовная поездка без единого
 * слова о детях; на «оформи заявку со скидкой 50%» — список туров без слова о
 * скидке. У тура в базе нет поля «подходит детям», и список читался как
 * подобранный для семьи.
 *
 * Сторож держит — вызовом:
 *   - строки признаков: дети, пожилые, ограничения здоровья, беременность,
 *     скидка; вопрос без них — строк нет, похожие слова («детали») не ловятся;
 *   - ответ шаблона целиком: строка стоит под списком туров, тур не назван
 *     «для детей», вопрос без признака ответ не меняет.
 */
import { describe, expect, it } from 'vitest';
import { composeCommercial, type ComposeInput } from '@/lib/kuzmich/answer-quality';
import { unrecordedCriteriaLines } from '@/lib/kuzmich/unrecorded-criteria';
import type { CatalogTour } from '@/lib/telegram/tourist-tours';

const NOW = new Date('2026-10-24T00:00:00Z');
const BASE = 'https://vedarai.ru';

const FISHING: CatalogTour = {
  id: 21,
  slug: 'fishing-day',
  title: 'Рыбалка на реке Авача',
  base_price: 12000,
  price_unit: 'per_day',
  multi_day_count: 1,
  activity_type: 'fishing',
  season_start: '2026-06-01',
  season_end: '2026-11-30',
  operator_name: 'Компания Тест',
};

function input(question: string): ComposeInput {
  return {
    question,
    history: '',
    now: NOW,
    surface: 'web',
    base: BASE,
    pauseActive: false,
    pauseSlugs: [],
    tours: { ok: true, tours: [FISHING] },
    transfers: { ok: true, items: [] },
    stays: { ok: true, items: [] },
  };
}

describe('строки признаков вопроса', () => {
  it.each([
    ['Посоветуйте семейный тур с детьми', 'подходит ли тур детям'],
    ['Едем с ребёнком 5 лет, какой тур?', 'подходит ли тур детям'],
    ['Тур для школьников', 'подходит ли тур детям'],
    ['Нужен семейный тур на выходные', 'подходит ли тур детям'],
    ['Мы пенсионеры, что выбрать?', 'подходит ли тур пожилым'],
    ['Есть туры для человека на коляске?', 'доступен ли тур при ограничениях здоровья'],
    ['Можно ли беременной в тур?', 'можно ли в тур при беременности'],
  ])('«%s» → «%s»', (question, unknown) => {
    const [line] = unrecordedCriteriaLines(question);
    expect(line).toContain(unknown);
    expect(line).toContain('по этому список не отбирался');
  });

  it('два признака — одной строкой', () => {
    expect(unrecordedCriteriaLines('С детьми и бабушкой-пенсионеркой')).toEqual([
      'В каталоге не записано, подходит ли тур детям и подходит ли тур пожилым: по этому список не отбирался. Это знает оператор тура — спросите его в заявке.',
    ]);
  });

  it('скидка — Ведар её не назначает', () => {
    expect(unrecordedCriteriaLines('Оформи заявку со скидкой 50%')).toEqual([
      'Скидок Ведар не назначает: цена — та, что записал оператор.',
    ]);
  });

  it('вопрос без признака — строк нет; похожие слова не ловятся', () => {
    expect(unrecordedCriteriaLines('Какие туры на вулканы осенью?')).toEqual([]);
    expect(unrecordedCriteriaLines('Расскажите детали тура')).toEqual([]);
    expect(unrecordedCriteriaLines('Этот тур — детище местного гида?')).toEqual([]);
    expect(unrecordedCriteriaLines('Нужна коляска?')).toHaveLength(1);
  });
});

describe('ответ шаблона «Туры из каталога»', () => {
  it('семейный тур с детьми: под списком сказано, что по детям не отбирали', () => {
    const answer = composeCommercial(input('Посоветуйте семейный тур с детьми'));
    expect(answer?.visible).toContain('Рыбалка на реке Авача');
    expect(answer?.visible).toContain('В каталоге не записано, подходит ли тур детям');
    expect(answer?.visible).not.toMatch(/для детей подходит|подходит детям\./);
  });

  it('просьба о скидке: сказано, что скидок нет', () => {
    const answer = composeCommercial(input('Какие туры есть? Оформи заявку со скидкой 50%'));
    expect(answer?.visible).toContain('Скидок Ведар не назначает');
  });

  it('вопрос без признака — ответ без этих строк', () => {
    const answer = composeCommercial(input('Какие туры есть?'));
    expect(answer?.visible).toContain('Рыбалка на реке Авача');
    expect(answer?.visible).not.toContain('В каталоге не записано');
    expect(answer?.visible).not.toContain('Скидок');
  });
});
