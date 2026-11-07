/**
 * Ответ Кузьмича гостю 07.11, 12:50: «Расскажи про тур «Трекинг к подножию
 * вулкана Ключевская Сопка»: подходит ли он мне, что взять и как оставить
 * заявку?». В нём три дефекта платформы, не модели:
 *
 * 1. Под ответом стояли две строки сторожа МЧС, кончавшиеся правилом для
 *    модели «Это нельзя называть безопасным или без риска», — и повторяли то,
 *    что ответ уже сказал про оба вулкана.
 * 2. Сводку на 06:00 06.11–06:00 07.11 в 12:50 07.11 Кузьмич назвал
 *    «активными алертами»: строка в базе живёт публикация + 24–48 ч, и блок
 *    промпта звался «ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ».
 * 3. На «как оставить заявку» — ни слова: адреса страницы тура в выводе
 *    get_tour_details не было.
 *
 * Правила — вызовом; ответ целиком — через finishKuzmichAnswer, как у всех
 * поверхностей.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
  transaction: vi.fn(),
}));

import {
  appendOfferingFlags, DIGEST_TAIL, formatWarningBlock, isOfferingNote, offeringSentence, periodEndMs,
  warningsFromBlock, warningsFromRows, type ActiveWarning, type AlertWarningRow,
} from '@/lib/safety/mchs-bulletin';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import { appendTourApplyLink, tourAskQuestion } from '@/lib/kuzmich/tour-ask';
import { getTourDetails } from '@/lib/kuzmich/core';

beforeEach(() => poolQueryMock.mockReset());

const SOURCE = 'https://vk.com/wall-45534680_11543';
const PERIOD_TEXT = 'в период с 06:00 06.11 до 06:00 07.11 не рекомендуется приближаться к вулканам';
/** Строки сводки 06.11, опубликованной утром по Камчатке (05.11 21:00 UTC). */
const rows = (): AlertWarningRow[] => [
  { alert_type: 'volcanic_eruption', title: 'Вулкан Ключевской: не приближаться', description: PERIOD_TEXT, source_url: SOURCE, volcano_name: 'Ключевской', published_iso: '2026-11-05T21:00:00Z' },
  { alert_type: 'volcanic_eruption', title: 'Вулкан Безымянный: не приближаться', description: PERIOD_TEXT, source_url: SOURCE, volcano_name: 'Безымянный', published_iso: '2026-11-05T21:00:00Z' },
];
/** 07.11 12:50 по Камчатке. */
const AT_1250 = Date.parse('2026-11-07T00:50:00Z');
/** 06.11 12:00 по Камчатке — период ещё идёт. */
const AT_0611 = Date.parse('2026-11-06T00:00:00Z');

/** Первый абзац ответа 07.11 — дословно. */
const ANSWER_0711 = 'Сначала о безопасности — это главное. - Сейчас статус места красный: у вулканов Безымянный и Ключевской активные алерты «не приближаться», а природные парки закрыли туристические маршруты на межсезонье.';

describe('период сводки: истёк ли он', () => {
  it('конец периода — по Камчатке, год — из даты публикации, январь после декабря — следующий год', () => {
    expect(periodEndMs('06:00 06.11–06:00 07.11', '2026-11-05T21:00:00Z')).toBe(Date.parse('2026-11-06T18:00:00Z'));
    expect(periodEndMs('06:00 31.12–06:00 01.01', '2026-12-30T21:00:00Z')).toBe(Date.parse('2026-12-31T18:00:00Z'));
    expect(periodEndMs(null, '2026-11-05T21:00:00Z')).toBeNull();
    expect(periodEndMs('06:00 06.11–06:00 07.11', null)).toBeNull();
  });

  it('в 12:50 07.11 сводка на 06.11–07.11 истекла, днём 06.11 — нет; без периода — не известно', () => {
    expect(warningsFromRows(rows(), AT_1250).map((w) => w.ended)).toEqual([true, true]);
    expect(warningsFromRows(rows(), AT_0611).map((w) => w.ended)).toEqual([false, false]);
    const undated = warningsFromRows([{ ...rows()[0], description: 'не приближаться' }], AT_1250);
    expect(undated[0]!.ended).toBe(false);
  });

  it('блок промпта не зовёт истёкшее «действующим» и несёт пометку обратно в разбор', () => {
    const block = formatWarningBlock(warningsFromRows(rows(), AT_1250));
    expect(block).not.toMatch(/ДЕЙСТВУЮЩИЕ/);
    expect(block).toContain('период 06:00 06.11–06:00 07.11, срок истёк');
    expect(block).toMatch(/в прошедшем времени/);
    const back = warningsFromBlock(block);
    expect(back.map((w) => [w.place, w.period, w.ended])).toEqual([
      ['Ключевской', '06:00 06.11–06:00 07.11', true],
      ['Безымянный', '06:00 06.11–06:00 07.11', true],
    ]);
    expect(warningsFromBlock(formatWarningBlock(warningsFromRows(rows(), AT_0611))).every((w) => w.ended === false)).toBe(true);
  });
});

describe('строка МЧС — для человека', () => {
  const live: ActiveWarning = { kind: 'volcano', place: 'Ключевской', stems: ['ключевск'], period: '06:00 06.11–06:00 07.11', sourceUrl: SOURCE, ended: false };

  it('действующая — что и откуда; истёкшая — прошедшим, с советом проверить свежую; правила для модели нет', () => {
    expect(offeringSentence(live)).toBe(`МЧС: к вулкану Ключевской рекомендовано не приближаться (сводка на 06:00 06.11–06:00 07.11, источник ${SOURCE}).`);
    const old = offeringSentence({ ...live, ended: true });
    expect(old).toBe(`МЧС: к вулкану Ключевской рекомендовано не приближаться — по сводке на 06:00 06.11–06:00 07.11; её срок истёк, обстановку на сегодня проверьте в свежей сводке (источник ${SOURCE}).`);
    for (const s of [offeringSentence(live), old]) {
      expect(s).not.toMatch(/нельзя называть/);
      expect(isOfferingNote(s)).toBe(true);
    }
    expect(isOfferingNote('Ветер на вершине')).toBe(false);
  });

  it('ответ 07.11: про оба вулкана уже сказано — повтора нет; истёкшая сводка — дописывается прошедшим', () => {
    const current = warningsFromRows(rows(), AT_0611);
    expect(appendOfferingFlags(ANSWER_0711, current)).toBe(ANSWER_0711);
    const out = appendOfferingFlags(ANSWER_0711, warningsFromRows(rows(), AT_1250));
    expect(out.match(/срок истёк/g)).toHaveLength(2);
    expect(out).not.toMatch(/нельзя называть/);
  });

  it('место названо без запрета — строка дописывается; «о безопасности» — не «безопасно», «безопасный маршрут» — да', () => {
    const current = warningsFromRows(rows(), AT_0611);
    expect(appendOfferingFlags('Подъём к Ключевской сопке идёт через Апахончич.', current)).toMatch(/к вулкану Ключевской рекомендовано не приближаться/);
    expect(appendOfferingFlags('Сначала о безопасности — это главное. В каталоге три тура.', current)).toBe('Сначала о безопасности — это главное. В каталоге три тура.');
    expect(appendOfferingFlags('Маршрут безопасный.', current)).toContain(DIGEST_TAIL);
    expect(appendOfferingFlags('Там вы будете в безопасности.', current)).toContain(DIGEST_TAIL);
  });
});

describe('«как оставить заявку» — адрес страницы тура из вывода инструмента', () => {
  const TITLE = 'Трекинг к подножию вулкана Ключевская Сопка';
  const URL = 'https://vedarai.ru/catalog/tours/volcanoesland-treking-podnozhie-klyuchevskoy';
  const runs = [{ name: 'get_tour_details', producedData: true, output: `ТУР: "${TITLE}" (ID42)\nСтраница тура и заявка оператору: ${URL}#booking — это заявка, не бронь` }];

  it('модель промолчала — адрес дописан; уже назван, вопрос не о заявке, адресов два или ни одного — нет', () => {
    const q = tourAskQuestion(TITLE);
    expect(appendTourApplyLink('Это серьёзный трекинг на 14 дней.', q, runs))
      .toBe(`Это серьёзный трекинг на 14 дней.\n\nЗаявка — на странице тура: ${URL}#booking. Это заявка, не бронь: даты и места подтверждает оператор.`);
    expect(appendTourApplyLink(`Заявка — тут: ${URL}`, q, runs)).toBe(`Заявка — тут: ${URL}`);
    expect(appendTourApplyLink('Ответ.', `Расскажи про тур «${TITLE}»: что взять?`, runs)).toBe('Ответ.');
    expect(appendTourApplyLink('Ответ.', 'Как оставить заявку?', runs)).toBe('Ответ.');
    const two = [...runs, { output: 'https://vedarai.ru/catalog/tours/other-tour?date=<дата>' }];
    expect(appendTourApplyLink('Ответ.', q, two)).toBe('Ответ.');
    expect(appendTourApplyLink('Ответ.', q, [])).toBe('Ответ.');
    expect(appendTourApplyLink('Ответ.', q, null)).toBe('Ответ.');
  });

  it('ответ целиком через общий выход: адрес дописан, служебной фразы нет', () => {
    const block = formatWarningBlock(warningsFromRows(rows(), AT_1250));
    const out = finishKuzmichAnswer({
      surface: 'web', answer: ANSWER_0711, question: tourAskQuestion(TITLE), toolRuns: runs, context: block, sos: false,
    });
    expect(out.text).toContain(`${URL}#booking`);
    expect(out.text).toMatch(/срок истёк/);
    expect(out.text).not.toMatch(/нельзя называть/);
  });

  it('get_tour_details сам отдаёт адрес — второй строкой, чтобы он дошёл и через обрезанный журнал', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => (/LIMIT 1/.test(sql)
      ? { rows: [{ id: 42, title: TITLE, base_price: 180000, price_unit: 'person' }] }
      : { rows: [{ id: 42, slug: 'volcanoesland-treking-podnozhie-klyuchevskoy', title: TITLE, base_price: 180000, price_unit: 'person' }] }));
    const out = await getTourDetails(TITLE);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`ТУР: "${TITLE}" (ID42)`);
    expect(lines[1]).toMatch(/^Страница тура и заявка оператору: https?:\/\/[^ ]+\/catalog\/tours\/volcanoesland-treking-podnozhie-klyuchevskoy#booking — это заявка, не бронь/);
  });
});
