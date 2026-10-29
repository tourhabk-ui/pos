/**
 * Каталог в ответе бота: даты заезда из базы, не календарь «в июле всё открыто».
 */
import { describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
import { emphasizeTripDays } from '@/lib/telegram/kuzmich-format';
import { detectTourIntent, isCarRentalAsk, isSafetyOrSituationAsk, wantsTourCards } from '@/lib/ai/booking-intent';
import { boundChatLane } from '@/lib/kuzmich/bound-chat-route';
import { catalogFacts, loadShowcaseTours, pickToursForAnswer, seasonOverlaps, showcaseLookup, showcaseQuery, type CatalogTour } from '@/lib/telegram/tourist-tours';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { enqueueTelegramChat, webhookAwaitsHandler } from '@/lib/telegram/update-lane';
import { matchTouristButton, touristRentalText, touristReplyMarkup } from '@/lib/telegram/tourist-keyboard';

const FIVE: CatalogTour = {
  id: 7,
  slug: 'pyat-dney',
  title: 'Пять дней по Камчатке',
  base_price: 180000,
  price_unit: 'per_person',
  multi_day_count: 5,
  season_start: '2027-08-25',
  season_end: '2027-09-30',
};

describe('даты тура против месяца в вопросе', () => {
  it('июль не получает заезд 25 августа — 30 сентября другого года', () => {
    expect(seasonOverlaps(FIVE, [7])).toBe(false);
    const now = new Date('2026-10-24T00:00:00Z');
    const facts = catalogFacts('Что посмотреть за 5 дней в июле?', { ok: true, tours: [FIVE] }, now);
    expect(facts.note).toContain('нет тура, который идёт');
    expect(facts.note).toContain('Пять дней по Камчатке');
    expect(facts.note).toContain('в это окно не попадают');
    expect(facts.note).toContain('25 августа 2027');
    expect(facts.note).not.toMatch(/180/);
    expect(facts.html).toContain('https://vedarai.ru/catalog/tours/pyat-dney');
    expect(facts.html).toContain('в это окно не попадают');
    expect(facts.inline).toBeUndefined();
  });

  it('лето называет месяцы, которых в сезоне нет, и не выдумывает цену', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const facts = catalogFacts('что посмотреть за 5 дней летом', { ok: true, tours: [FIVE] }, now);
    expect(facts.note).toContain('июне');
    expect(facts.note).toContain('июле');
    expect(facts.note).toContain('25 августа 2027');
    const bare = catalogFacts('что посмотреть за 5 дней летом', {
      ok: true,
      tours: [{ ...FIVE, base_price: null }],
    }, now);
    expect(bare.note).toContain('цена не указана');
    expect(bare.note).not.toMatch(/от 0/);
  });

  it('«посмотреть погоду» и «за 3 дня до вылета» туры не тянут', () => {
    expect(detectTourIntent('Что посмотреть за 5 дней летом').detected).toBe(true);
    expect(detectTourIntent('посмотреть погоду на завтра').detected).toBe(false);
    expect(wantsTourCards('Хочу арендовать авто')).toBe(false);
    expect(isCarRentalAsk('я турист, хочу арендовать авто')).toBe(true);
    expect(wantsTourCards('я турист, хочу арендовать авто')).toBe(false);
    expect(catalogFacts('я турист, хочу арендовать авто', { ok: true, tours: [FIVE] }).html).toBe('');
    expect(isCarRentalAsk('хочу тур и арендовать авто')).toBe(false);
    expect(wantsTourCards('хочу')).toBe(false);
    expect(wantsTourCards('туры на вулканы')).toBe(true);
    expect(detectTourIntent('за 3 дня до вылета').detected).toBe(false);
    expect(catalogFacts('посмотреть погоду на завтра', { ok: true, tours: [FIVE] }).html).toBe('');
    expect(catalogFacts('за 3 дня до вылета', { ok: true, tours: [FIVE] }).html).toBe('');
    expect(catalogFacts('за 3 дня до вылета', { ok: false }).note).toBe('');
  });

  it('указание модели про единицу цены в карточку туристу не попадает', () => {
    const facts = catalogFacts('что посмотреть за 5 дней', {
      ok: true,
      tours: [{ ...FIVE, price_unit: 'неизвестно' }],
    }, new Date('2027-09-10T00:00:00Z'));
    expect(facts.note).toContain('не называй её ценой с человека');
    expect(facts.html).not.toContain('не называй');
    expect(facts.html).toContain('не записано');
  });

  it('рыбалка не запирается на чужой длинный тур', () => {
    const fish: CatalogTour = {
      ...FIVE,
      id: 2,
      slug: 'rybalka',
      title: 'Рыбалка на неделю',
      activity_type: 'fishing',
      multi_day_count: 7,
    };
    const facts = catalogFacts('хочу на рыбалку', { ok: true, tours: [FIVE, fish] }, new Date('2027-09-10T00:00:00Z'));
    expect(facts.note).toContain('Рыбалка на неделю');
    expect(facts.note).not.toContain('Пять дней');
    expect(facts.html).toContain('/catalog/tours/rybalka');
    expect(facts.html).not.toContain('pyat-dney');
  });

  it('вопрос про вулкан без такого тура чужой не подставляет', () => {
    const facts = catalogFacts('хочу на вулкан', { ok: true, tours: [FIVE] });
    expect(facts.note).toContain('нет живого тура этого вида');
    expect(facts.html).not.toContain('pyat-dney');
    expect(facts.inline).toBeUndefined();
  });

  it('названный вулкан берёт джип к нему и не берёт восхождение на другой', () => {
    const other: CatalogTour = {
      ...FIVE,
      id: 3,
      slug: 'klyuchi',
      title: 'Восхождение на Ключевскую сопку',
      activity_type: 'volcano',
    };
    const jeep: CatalogTour = {
      ...FIVE,
      id: 4,
      slug: 'jeep-ava',
      title: 'Джип на перевал',
      activity_type: 'jeep',
      location_name: 'Авачинский перевал',
      multi_day_count: 1,
    };
    const inSeason = new Date('2027-09-10T00:00:00Z');
    const facts = catalogFacts('хочу тур на Авачинский', { ok: true, tours: [other, jeep] }, inSeason);
    expect(facts.note).toContain('Джип на перевал');
    expect(facts.note).not.toContain('Ключевск');
    expect(facts.html).toContain('/catalog/tours/jeep-ava');
    const onlyOther = catalogFacts('хочу тур на Авачинский', { ok: true, tours: [other] });
    expect(onlyOther.note).toContain('нет живого тура к этому вулкану');
    expect(onlyOther.html).not.toContain('klyuchi');
  });

  it('«что посмотреть у реки» не становится запросом только сплава', () => {
    const raft: CatalogTour = {
      ...FIVE,
      id: 8,
      slug: 'splav',
      title: 'Сплав по реке',
      activity_type: 'rafting',
      multi_day_count: 2,
    };
    const facts = catalogFacts('что посмотреть за 5 дней у реки', { ok: true, tours: [FIVE, raft] }, new Date('2027-09-10T00:00:00Z'));
    expect(showcaseLookup('что посмотреть за 5 дней у реки').kind).toBe('general');
    expect(facts.note).toContain('Пять дней по Камчатке');
    expect(facts.note).not.toContain('нет живого тура этого вида');
  });

  it('срез длинных туров не объявляет, что вида в каталоге нет', () => {
    const facts = catalogFacts('хочу на рыбалку', { ok: true, tours: [FIVE], complete: false });
    expect(facts.html).toBe('');
    expect(facts.note).toBe('');
    const query = showcaseQuery('хочу на Авачинский');
    expect(query.sql).toContain('ILIKE ANY');
    expect(query.sql).not.toContain('activity_type =');
    expect(query.params[0]).toEqual(expect.arrayContaining([expect.stringMatching(/%авачин/i)]));
  });

  it('аренда авто не подмешивает туры', () => {
    const facts = catalogFacts('Хочу арендовать авто', { ok: true, tours: [FIVE] });
    expect(facts.html).toBe('');
    expect(facts.inline).toBeUndefined();
  });

  it('сезон длиннее года: июль в нём есть, ложного «в июле нет» нет (находка 24.10)', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const year: CatalogTour = {
      ...FIVE, id: 31, slug: 'kruglyi-god', title: 'Круглый год', multi_day_count: 1,
      season_start: '2026-10-01', season_end: '2027-10-31',
    };
    expect(seasonOverlaps(year, [7])).toBe(true);
    const july = catalogFacts('что посмотреть в июле', { ok: true, tours: [year] }, now);
    expect(july.html).toContain('/catalog/tours/kruglyi-god');
    expect(july.html).not.toContain('этого заезда нет');
    expect(july.note).not.toContain('этого заезда нет');
    // Месяцы считаются по окну вопроса с годом: летом 2027 этот заезд идёт
    // только в июне — июль и август названы, июнь нет.
    const toJune: CatalogTour = { ...year, slug: 'do-iyunya', title: 'До июня', season_start: '2026-06-01', season_end: '2027-06-30' };
    const summer = catalogFacts('что посмотреть летом', { ok: true, tours: [toJune] }, now);
    expect(summer.html).toContain('В июле, августе этого заезда нет.');
    expect(summer.html).not.toContain('В июне');
  });

  it('вулкан назван после 400-го знака описания — тур, найденный запросом, остаётся (находка 24.10)', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const description = `${'Выезд из города на джипах по грунтовке. '.repeat(12)}К вечеру — подножие Мутновского вулкана.`;
    // Так строку отдаёт запрос витрины: описание обрезано, текст поиска — целиком.
    const row: CatalogTour = {
      ...FIVE, id: 21, slug: 'jeep-weekend', title: 'Джип-тур выходного дня', activity_type: 'jeep',
      multi_day_count: 1, season_start: '2026-06-01', season_end: '2026-12-31',
      description: description.slice(0, 400),
      match_text: `Джип-тур выходного дня  ${description}`,
    };
    expect(row.description).not.toMatch(/мутнов/i);
    const picked = pickToursForAnswer('туры на Мутновский вулкан', { ok: true, tours: [row], complete: true }, now);
    expect(picked.kind).toBe('list');
    expect(picked.tours.map((t) => t.slug)).toEqual(['jeep-weekend']);
    expect(picked.line).not.toContain('нет живого тура');
    expect(showcaseQuery('туры на Мутновский вулкан').sql).toContain('AS match_text');
  });

  it('подпись кнопки тура — цена для человека, без указания модели и без обрубка (находка 24.10)', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const raft: CatalogTour = {
      ...FIVE, id: 41, slug: 'splav-bystraya', title: 'Сплав по Быстрой', base_price: 9000, price_unit: null,
      multi_day_count: 1, season_start: '2026-06-01', season_end: '2026-12-31',
    };
    const label = catalogFacts('подобрать тур', { ok: true, tours: [raft] }, now).inline?.inline_keyboard[0]?.[0]?.text ?? '';
    expect(label).toMatch(/^Сплав по Быстрой · от 9\s000 ₽, за что — не записано$/u);
    const longTitle = 'Сплав по реке Быстрая с ночёвкой у костра и рыбалкой на хариуса';
    const long = catalogFacts('подобрать тур', { ok: true, tours: [{ ...raft, title: longTitle }] }, now)
      .inline?.inline_keyboard[0]?.[0]?.text ?? '';
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^Сплав по реке.*… · от 9\s000 ₽, за что — не записано$/u);
    for (const text of [label, long]) {
      expect(text).not.toContain('не называй');
      expect(text).not.toMatch(/не зап…$/);
    }
  });

  it('каталог не прочитан — цены нет, а не ноль', () => {
    const facts = catalogFacts('покажи туры на 5 дней', { ok: false });
    expect(facts.note).toContain('не прочитан');
    expect(facts.note).not.toMatch(/\d{3,}/);
  });
});

describe('вопрос о безопасности и обстановке — без витрины туров (находка 24.10)', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  const AVA: CatalogTour = {
    ...FIVE, id: 51, slug: 'ava', title: 'Восхождение на Авачинский вулкан', activity_type: 'volcano',
    multi_day_count: 1, location_name: 'Авачинский', season_start: '2026-06-01', season_end: '2026-12-31',
  };
  const SAFETY = [
    'хочу понять, безопасно ли идти в поход при ветре',
    'хочу узнать, открыт ли перевал',
    'какие опасности на Авачинском вулкане?',
    'какие вулканы сейчас извергаются?',
    'безопасен ли тур на вулкан при сильном ветре?',
    'какая обстановка на Авачинском, хочу тур',
    'есть ли штормовое предупреждение МЧС на выходные, хочу в поход',
    'открыта ли туристическая тропа на Авачинский, хочу в поход',
  ];

  it.each(SAFETY)('«%s» — ни карточек сайта, ни туров каталога в Telegram', (question) => {
    expect(isSafetyOrSituationAsk(question)).toBe(true);
    expect(wantsTourCards(question)).toBe(false);
    const facts = catalogFacts(question, { ok: true, tours: [AVA] }, now);
    expect(facts.html).toBe('');
    expect(facts.note).toBe('');
    expect(facts.inline).toBeUndefined();
  });

  it('просьба о туре без вопроса об опасности — карточки на месте; «водопад Опасный» — имя места', () => {
    for (const question of [
      'туры на вулканы', 'хочу тур на Авачинский вулкан', 'тур к водопаду Опасный', 'открыта ли запись на тур в июле',
      // «Открыты ли туры / места» — вопрос к витрине, не к обстановке (ревью 25.10).
      'открыты ли туры на август', 'открыты ли ещё места на тур в июле',
    ]) {
      expect(isSafetyOrSituationAsk(question), question).toBe(false);
      expect(wantsTourCards(question), question).toBe(true);
    }
    expect(catalogFacts('туры на вулканы', { ok: true, tours: [AVA] }, now).html).toContain('/catalog/tours/ava');
  });
});

describe('аренда машины — один словарь вида машины (находка 24.10)', () => {
  const RENTAL = [
    'хочу арендовать джип',
    'хочу на прокат джип',
    'аренда внедорожника',
    'прокат 4x4',
    'аренда 4х4 на три дня',
    'хочу rent a car',
    'прокат suv',
    'где автопрокат в Петропавловске, нужен',
    'аренда авто',
    'хочу арендовать машину',
  ];

  it.each(RENTAL)('«%s» — аренда и для паузы проката, и для привязанного чата', (question) => {
    expect(isCarRentalAsk(question)).toBe(true);
    expect(wantsTourCards(question)).toBe(false);
    expect(catalogFacts(question, { ok: true, tours: [FIVE] }).html).toBe('');
    expect(boundChatLane(question)).toBe('tourist');
  });

  it('слово целиком: «авторский маршрут» — не машина; тур рядом с арендой — не аренда', () => {
    expect(isCarRentalAsk('аренда снаряжения на авторский маршрут')).toBe(false);
    expect(isCarRentalAsk('хочу тур и арендовать джип')).toBe(false);
  });

  it('«прокатиться на джипе» — глагол поездки, не аренда; «напрокат» — аренда (ревью 25.10)', () => {
    for (const question of ['хочу прокатиться на джипе к Мутновскому', 'прокатимся на вездеходе по побережью', 'нас прокатят на внедорожнике?']) {
      expect(isCarRentalAsk(question), question).toBe(false);
    }
    for (const question of ['возьму джип напрокат', 'прокат джипа на выходные', 'прокатный внедорожник есть?']) {
      expect(isCarRentalAsk(question), question).toBe(true);
    }
  });
});

describe('клавиатура туриста', () => {
  it('пять кнопок и аренда без кабинета', () => {
    const labels = touristReplyMarkup().keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Подобрать тур', 'Погода', 'Аренда авто', 'Операторы', 'Задать вопрос']);
    expect(matchTouristButton('  погода ')).toBe('Погода');
    expect(matchTouristButton('покажи туры')).toBeNull();
    const rental = touristRentalText(new Date('2026-10-24T12:00:00Z'));
    expect(rental).toContain('не показывается');
    expect(rental).not.toMatch(/Лагуна|FLO/i);
    expect(rental).not.toContain('подключён к оператору');
  });
});

describe('дни в ответе', () => {
  it('строка дня жирная, переносы на месте', () => {
    const html = emphasizeTripDays('Сначала сезон.\nДень 1 — берег\nДень 2 — сопка');
    expect(html).toContain('<b>День 1 — берег</b>');
    expect(html).toContain('<b>День 2 — сопка</b>');
    expect(html).toContain('\n');
  });
});

describe('очередь чата', () => {
  it('второй ход не обгоняет первый', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const key = `chat-${Date.now()}`;
    const first = enqueueTelegramChat(key, async () => {
      order.push('start-1');
      await gate;
      order.push('end-1');
    });
    const second = enqueueTelegramChat(key, async () => {
      order.push('end-2');
    });
    await Promise.resolve();
    expect(order).toEqual(['start-1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start-1', 'end-1', 'end-2']);
  });

  it('первый ход упал — второй всё равно идёт, после него (находка 24.10)', async () => {
    const order: string[] = [];
    const key = `chat-fail-${Date.now()}`;
    const first = enqueueTelegramChat(key, async () => {
      order.push('start-1');
      await Promise.resolve();
      throw new Error('первый ход упал');
    });
    const second = enqueueTelegramChat(key, async () => {
      order.push('run-2');
    });
    await expect(first).rejects.toThrow('первый ход упал');
    await second;
    expect(order).toEqual(['start-1', 'run-2']);
  });

  it('на сервере вебхук не ждёт модель', () => {
    expect(webhookAwaitsHandler({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('витрина туров в чате — правило 1в (слово владельца 29.10)', () => {
  it('в запросе нет ни порядка, ни среза: «многодневные и дешёвые первыми» сняты', () => {
    for (const q of ['туры', 'хочу на Авачинский', 'хочу на рыбалку']) {
      const { sql } = showcaseQuery(q);
      // Подзапрос ближайшей даты несёт свои ORDER BY и LIMIT 1 — это выбор
      // даты одного тура, а не порядок списка; судится внешний запрос.
      expect(sql.replace(nearestFreeDateSql('ot'), '')).not.toMatch(/ORDER BY|LIMIT/);
      expect(sql).toContain('AS nearest_free_date');
      expect(sql).toContain('AS main_place_ref');
    }
  });

  it('порядок списка — правило 1в: с датой первыми, остальные жребием дня, а не ценой', async () => {
    const rows = [
      { ...FIVE, id: 1, base_price: 5000, nearest_free_date: null },
      { ...FIVE, id: 2, base_price: 900000, nearest_free_date: '2027-07-26' },
      { ...FIVE, id: 3, base_price: 7000, nearest_free_date: null },
      { ...FIVE, id: 4, base_price: 6000, nearest_free_date: null },
    ];
    query.mockResolvedValueOnce({ rows });
    const loaded = await loadShowcaseTours('туры');
    if (!loaded.ok) throw new Error('каталог не прочитан');
    expect(loaded.complete).toBe(true);
    expect(loaded.tours[0].id).toBe(2);
    expect(loaded.tours.map((t) => t.id))
      .toEqual(orderOffersBy(rows, (t) => ({ id: t.id, nearestFreeDate: t.nearest_free_date })).map((t) => t.id));
  });

  it('у каждого тура в карточке чата — компания', () => {
    const facts = catalogFacts('Какие туры есть?', { ok: true, tours: [{ ...FIVE, operator_name: 'Местечко Камчатка' }] }, new Date('2027-08-26T00:00:00Z'));
    expect(facts.html).toContain('</a> — Местечко Камчатка —');
    expect(facts.note).toContain('«Пять дней по Камчатке» (Местечко Камчатка)');
  });
});
