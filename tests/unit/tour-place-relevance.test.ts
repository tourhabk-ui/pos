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
 *
 * Вечер того же дня, владелец: «и даже не один тур». Отсев чужого
 * проверялся на выдуманном туре «Восхождение на Авачинский вулкан» с типом
 * volcano. В настоящем каталоге к Авачинскому ведут джип и снегоход, а тип
 * volcano — у одной Ключевской: SQL отбирал кандидатов по типу, и туров к
 * Авачинскому среди них не было никогда. Поэтому вторая половина сторожа —
 * на строках настоящего каталога и на том, что подбор отправляет в базу:
 * названный вулкан приводит туры к нему ЛЮБОГО типа и первыми, слово
 * «вулкан» — тип ИЛИ название, и всё это за шлюзом витрины. Отбор тем же
 * SQL проверен на локальном PostgreSQL с каталогом из миграций.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { namedVolcanoes, pickToursForMessage, volcanoNamePatterns } from '@/lib/ai/tour-place-relevance';
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

describe('образцы отбора по названному вулкану', () => {
  it('основа каждого слова имени, только буквы', () => {
    expect(volcanoNamePatterns(['Авачинский'])).toEqual(['%авачин%']);
    expect(volcanoNamePatterns(['Плоский Толбачик'])).toEqual(['%плоск%', '%толбачик%']);
    expect(volcanoNamePatterns([])).toEqual([]);
    for (const p of volcanoNamePatterns(namedVolcanoes('Мутновский и Горелый, Ключевская сопка'))) {
      expect(p).toMatch(/^%[а-я]+%$/);
    }
  });
});

/** Строки настоящего каталога (MCP get_tours, 13.10): к Авачинскому — джип и снегоход, тип volcano — только у Ключевской. */
const REAL = {
  jeep: { id: 62, slug: null, title: 'Авачинский перевал', activity_type: 'jeep_safari', location: 'Авачинский перевал', description: 'Джип-тур по руслу Сухой речки к Авачинскому перевалу и подъём на экструзию Верблюд между Авачинским и Корякским вулканами.', base_price: 11000, operator_name: 'Местечко Камчатка' },
  snow: { id: 52, slug: null, title: 'Авачинский перевал (снегоход)', activity_type: 'snowmobile', location: 'Авачинский перевал', description: 'Зимняя снегоходная экскурсия по руслу Сухой речки к подножию Авачинского и Корякского вулканов.', base_price: 10000, operator_name: 'Местечко Камчатка' },
  klyuch: { id: 46, slug: null, title: 'Восхождение на вулкан Ключевская Сопка', activity_type: 'volcano', location: 'Вулкан Ключевская Сопка', description: 'Экстремальный тур для подготовленных: вертолётная заброска к кратеру Перевальный (2700 м), перевал Вулканологов', base_price: 320000, operator_name: 'Край Вулканов' },
};

describe('findRelevantTours: кандидаты по месту, а не только по типу', () => {
  beforeEach(() => { query.mockReset(); });
  const sqlOf = (i: number) => String(query.mock.calls[i]![0]).replace(/\s+/g, ' ');

  it('«и даже не один тур»: туры к Авачинскому любого типа — в отборе и первыми, Ключевская отсеяна', async () => {
    // Порядок строк — как его задаёт ORDER BY: совпавшие местом первыми.
    query.mockResolvedValueOnce({ rows: [REAL.jeep, REAL.snow, REAL.klyuch] });
    const out = await findRelevantTours('volcano', PROBE_QUESTION, 3);
    expect(out.map((t) => t.id)).toEqual([62, 52]);

    expect(query.mock.calls[0]![1]).toEqual([12, 'volcano', '%вулкан%', ['%авачин%']]);
    const sql = sqlOf(0);
    // Тип и место — через ИЛИ: тип не сужает туры к месту.
    expect(sql).toContain(
      "((ot.activity_type = $2 OR translate(ot.title, 'Ёё', 'Ее') ILIKE $3) OR translate(concat_ws(' ', ot.title, ot.location_name, ot.description), 'Ёё', 'Ее') ILIKE ANY($4::text[]))",
    );
    expect(sql).toMatch(/ORDER BY \(translate\(concat_ws\(.+\) ILIKE ANY\(\$4::text\[\]\)\) DESC, ot\.created_at DESC LIMIT \$1/);
  });

  it('вулкан не назван: слово «вулкан» — тип ИЛИ название, порядок по новизне', async () => {
    query.mockResolvedValueOnce({ rows: [REAL.jeep, REAL.klyuch] });
    const out = await findRelevantTours('volcano', 'хочу на вулкан', 3);
    expect(out.map((t) => t.id)).toEqual([62, 46]);
    expect(query.mock.calls[0]![1]).toEqual([12, 'volcano', '%вулкан%']);
    const sql = sqlOf(0);
    expect(sql).toContain("(ot.activity_type = $2 OR translate(ot.title, 'Ёё', 'Ее') ILIKE $3)");
    expect(sql).not.toContain('ILIKE ANY');
    expect(sql).toMatch(/ORDER BY ot\.created_at DESC LIMIT \$1/);
  });

  it('без вида активности — весь каталог, туры к названному вулкану первыми', async () => {
    query.mockResolvedValueOnce({ rows: [REAL.jeep, REAL.snow] });
    await findRelevantTours(null, 'тур на Авачинский', 3);
    expect(query.mock.calls[0]![1]).toEqual([12, ['%авачин%']]);
    const sql = sqlOf(0);
    expect(sql).not.toContain('activity_type =');
    expect(sql).toContain("ILIKE ANY($2::text[])) DESC, ot.created_at DESC");
  });

  it('шлюз витрины в обоих запросах: снятый с витрины тур в чат не идёт', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await findRelevantTours('rafting', 'хочу сплав', 3);
    expect(query).toHaveBeenCalledTimes(2);
    for (const i of [0, 1]) expect(sqlOf(i)).toContain('ot.is_published = true');
  });
});
