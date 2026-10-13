/**
 * Туры в подсказке модели — про названный вулкан (проба 764, 13.10).
 *
 * Вопрос «какая сейчас обстановка у Авачинского вулкана?» получил ответ про
 * Ключевскую сопку и тур за 320 000 ₽: подбор туров на слово «вулкан» брал
 * три самых новых тура по вулканам и не видел, какой вулкан назван.
 * Инструменты в тот же час отвечали верно — подменяла подсказка.
 *
 * Сторож держит: распознавание названного вулкана в обоих падежах и в
 * составных именах; тур про чужой вулкан не проходит, свой идёт первым,
 * общий остаётся; без названного вулкана — прежний порядок; подбор берёт
 * кандидатов с запасом и отдаёт отфильтрованное.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { namedVolcanoes, pickToursForMessage } from '@/lib/ai/tour-place-relevance';
import { findRelevantTours } from '@/lib/ai/booking-intent';

const PROBE_QUESTION = 'Служебная проверка журнала общения Ведара: какая сейчас обстановка у Авачинского вулкана? Ответь в двух предложениях.';

const KLYUCH = { title: 'Восхождение на вулкан Ключевская Сопка', location: 'Ключевская группа вулканов', description: 'Самый высокий действующий вулкан Евразии' };
const GENERIC = { title: 'Вулканы Камчатки за один день', location: 'Петропавловск-Камчатский', description: 'Обзорная поездка' };
const AVACHA = { title: 'Восхождение на Авачинский вулкан', location: 'Авачинский перевал', description: 'Подъём на действующий вулкан у города' };
const MUTNOV = { title: 'Мутновский и Горелый за два дня', location: 'Мутновское плато', description: 'Фумаролы и кратерные озёра' };

describe('названный вулкан распознаётся', () => {
  it('вопрос с прода: Авачинский в родительном падеже', () => {
    expect(namedVolcanoes(PROBE_QUESTION)).toEqual(['Авачинский']);
  });

  it('прилагательное в любом роде и падеже, фамилия в родительном', () => {
    expect(namedVolcanoes('Восхождение на вулкан Ключевская Сопка')).toEqual(['Ключевской']);
    expect(namedVolcanoes('что на Ключевском сейчас')).toEqual(['Ключевской']);
    expect(namedVolcanoes('Вулкан Крашенинникова')).toEqual(['Крашенинников']);
  });

  it('составное имя не раздваивается: «Плоский Толбачик» — не ещё и «Толбачик»', () => {
    expect(namedVolcanoes('извержение Плоского Толбачика')).toEqual(['Плоский Толбачик']);
    expect(namedVolcanoes('Плоский Толбачик')).toEqual(['Плоский Толбачик']);
    expect(namedVolcanoes('Толбачик')).toEqual(['Толбачик']);
  });

  it('два вулкана — оба; ни одного — пусто', () => {
    expect(namedVolcanoes('Мутновский и Горелый за два дня').sort()).toEqual(['Горелый', 'Мутновский']);
    expect(namedVolcanoes('хочу на рыбалку с детьми в мае')).toEqual([]);
    expect(namedVolcanoes('какие туры на вулканы есть?')).toEqual([]);
  });
});

describe('подбор туров для подсказки', () => {
  it('вопрос про Авачинский: тур про Ключевскую не проходит, свой первым, общий остаётся', () => {
    // Порядок кандидатов — как отдаёт база: самый новый первым (импорт «Края Вулканов»).
    const picked = pickToursForMessage(PROBE_QUESTION, [KLYUCH, GENERIC, MUTNOV, AVACHA], 3);
    expect(picked).toEqual([AVACHA, GENERIC]);
    expect(picked).not.toContain(KLYUCH);
  });

  it('названный вулкан без своих туров — только общие, чужих нет', () => {
    expect(pickToursForMessage('обстановка у Шивелуча', [KLYUCH, MUTNOV], 3)).toEqual([]);
    expect(pickToursForMessage('обстановка у Шивелуча', [KLYUCH, GENERIC], 3)).toEqual([GENERIC]);
  });

  it('вулкан не назван — прежний порядок и лимит', () => {
    expect(pickToursForMessage('хочу на вулкан', [KLYUCH, GENERIC, MUTNOV, AVACHA], 3)).toEqual([KLYUCH, GENERIC, MUTNOV]);
  });
});

describe('findRelevantTours берёт кандидатов с запасом и отдаёт отфильтрованное', () => {
  beforeEach(() => { query.mockReset(); });

  it('лимит кандидатов в SQL — вчетверо, наружу — не больше limit, без чужих вулканов', async () => {
    const row = (t: typeof KLYUCH, id: string) => ({ id, slug: id, title: t.title, location: t.location, description: t.description, base_price: 1000, operator_name: 'Оператор' });
    query.mockResolvedValueOnce({ rows: [row(KLYUCH, 'k'), row(GENERIC, 'g'), row(MUTNOV, 'm'), row(AVACHA, 'a')] });
    const out = await findRelevantTours('volcano', PROBE_QUESTION, 3);
    expect(query.mock.calls[0]![1]).toEqual([12, 'volcano']);
    expect(out.map((t) => t.id)).toEqual(['a', 'g']);
  });
});
