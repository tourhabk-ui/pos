// @vitest-environment node
/**
 * Судья Кузьмича видит то же, что видел Кузьмич (разбор плохих оценок 11.11,
 * #3179).
 *
 * Шесть плохих оценок недели разобраны по текстам с экрана
 * /hub/admin/kuzmich-outcomes. Ни одна не доказывала ошибку Кузьмича — все
 * упирались в то, чего судья не видел:
 *  - ответ резался на 800 знаках: «обрывается на полуслове», «нет информации,
 *    как оставить заявку, что взять, о жилье и машине» — в четырёх из шести;
 *  - сегодняшней даты не было: верное «сейчас ноябрь, маршрут закрыт» на
 *    вопрос об августе судья назвал противоречием;
 *  - данных инструментов не было: настоящие туры и цены каталога он называл
 *    «возможно выдуманными».
 *
 * Сторож — вызовом: что собирает buildJudgePrompt и что уходит судье из
 * настоящего gradeKuzmichResponse (модель и база подменены).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { db, fast } = vi.hoisted(() => ({
  db: { knowledge: [] as unknown[][] },
  fast: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO agent_knowledge/.test(sql)) db.knowledge.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => ({ rows: [], rowCount: /INSERT INTO ai_actions_log/.test(sql) ? 1 : 0 })),
      release: vi.fn(),
    })),
  },
}));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => fast(...a) }));

import {
  buildJudgePrompt, judgeToolData, gradeKuzmichResponse, JUDGE_ANSWER_KEEP, JUDGE_DATA_KEEP,
} from '@/lib/agents/managed/kuzmich-outcomes';

const QUESTION = 'Расскажи про тур «Курильское озеро (вертолёт)»: подходит ли он мне, что взять и как оставить заявку?';
/** Ответ из трёх частей: ответ на третий вопрос стоит дальше 800-го знака. */
const ANSWER = `Сначала про безопасность, потому что это главное. ${'Медведи у озера ходят рядом с людьми, держитесь группы. '.repeat(16)}`
  + 'Что взять: непромокаемую куртку и сменную обувь. Как оставить заявку: кнопка «Заявка» на странице тура.';
const TOUR_DATA = 'ID12: "Курильское озеро (вертолёт)" — от 85 000 р/чел | Оп: Тест | Мест: 4';

describe('buildJudgePrompt — что видит судья', () => {
  it('ответ целиком: конец ответа дальше 800-го знака виден судье', () => {
    expect(ANSWER.length).toBeGreaterThan(900);
    const p = buildJudgePrompt(QUESTION, ANSWER, []);
    expect(p).toContain('Как оставить заявку: кнопка «Заявка»');
    expect(p).not.toMatch(/ответ длиннее/);
  });

  it('ответ длиннее предела — сказано, сколько показано', () => {
    const long = 'а'.repeat(JUDGE_ANSWER_KEEP + 500);
    const p = buildJudgePrompt(QUESTION, long, []);
    expect(p).toContain(`показано ${JUDGE_ANSWER_KEEP} из ${JUDGE_ANSWER_KEEP + 500} знаков`);
  });

  it('сегодняшняя дата — по Камчатке, а не по UTC', () => {
    // 20:00 UTC 10 ноября — на Камчатке уже 08:00 11 ноября.
    const p = buildJudgePrompt(QUESTION, ANSWER, [], new Date('2026-11-10T20:00:00Z'));
    expect(p).toMatch(/СЕГОДНЯ ПО КАМЧАТКЕ: 11 ноября 2026/);
  });

  it('данные инструментов, принёсших факты, — в запросе судье', () => {
    const p = buildJudgePrompt(QUESTION, ANSWER, [{ name: 'get_tour_details', producedData: true, output: TOUR_DATA }]);
    expect(p).toContain('[get_tour_details]');
    expect(p).toContain('от 85 000 р/чел');
  });

  it('рубрика: непроверяемое — «не проверено», а не «может быть выдумано»', () => {
    const p = buildJudgePrompt(QUESTION, ANSWER, []);
    expect(p).toMatch(/не проверено: <что>/);
    expect(p).toMatch(/ДАННЫМИ ИНСТРУМЕНТОВ/);
  });
});

describe('judgeToolData — какие данные и в каком виде', () => {
  it('журнала нет — так и сказано, и это не «ничего не принесли»', () => {
    expect(judgeToolData(undefined)).toMatch(/Журнал вызовов не передан/);
    expect(judgeToolData([])).toMatch(/ничего не принесли/);
  });

  it('вызов без данных и заявка с именем туриста судье не уходят', () => {
    const out = judgeToolData([
      { name: 'get_tours', producedData: false, output: 'Туров не найдено.' },
      { name: 'create_booking_request', producedData: true, output: 'Заявка принята: Тест Тестов, 2 человека' },
      { name: 'get_guardian_context', producedData: true, output: 'Курильское озеро: ЖЁЛТЫЙ, медведи' },
    ]);
    expect(out).not.toContain('Туров не найдено');
    expect(out).not.toContain('Тест Тестов');
    expect(out).toContain('Курильское озеро: ЖЁЛТЫЙ');
  });

  it('телефон и почта в данных вычищены', () => {
    const out = judgeToolData([{ name: 'get_tour_details', producedData: true, output: 'Оператор: +7 900 000-00-00, test@example.com' }]);
    expect(out).not.toContain('test@example.com');
    expect(out.replace(/\D/g, '')).not.toContain('9000000000');
  });

  it('план без сметы — не данные: судье не показан', () => {
    expect(judgeToolData([{ name: 'make_trip_plan', producedData: true, output: 'План не собран: число взрослых не разобрал.' }]))
      .toMatch(/ничего не принесли/);
  });

  it('данных больше предела — сказано, что обрезаны, и непоказанное не выдумка', () => {
    const out = judgeToolData([{ name: 'get_tours', producedData: true, output: 'х'.repeat(JUDGE_DATA_KEEP + 100) }]);
    expect(out).toMatch(/данные обрезаны/);
    expect(out).toMatch(/непроверенным, а не выдумкой/);
  });
});

describe('gradeKuzmichResponse — судья получает собранный запрос', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    db.knowledge = [];
    fast.mockReset();
    fast.mockResolvedValue('{"score": 5, "issues": ["нет снаряжения"]}');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('конец ответа и данные тура доходят до судьи; длина ответа — в записи', async () => {
    await gradeKuzmichResponse(QUESTION, ANSWER, 'web-1', {
      surface: 'web',
      toolRuns: [{ name: 'get_tour_details', producedData: true, output: TOUR_DATA }],
    });
    expect(fast).toHaveBeenCalledTimes(1);
    const sent = (fast.mock.calls[0]![0] as Array<{ content: string }>).map((m) => m.content).join('\n');
    expect(sent).toContain('Как оставить заявку: кнопка «Заявка»');
    expect(sent).toContain('от 85 000 р/чел');
    expect(sent).toMatch(/СЕГОДНЯ ПО КАМЧАТКЕ: \d{1,2} [а-я]+ \d{4}/);
    const meta = JSON.parse(db.knowledge[0]![3] as string) as { answer_len: number };
    expect(meta.answer_len).toBe(ANSWER.length);
  });
});
