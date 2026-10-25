/**
 * Кузьмич: качество ответов. Семь живых вопросов подряд.
 *
 * Цены только из фикстур этого хода, сезон режется годом, пауза Лагуны
 * убирает источник, повтор абзаца не проходит, запрос оператору есть.
 * Модель не вызывается.
 *
 * Откуда просадка (уже в main, не бюджет контекста и не id модели):
 * #2765 (28319d089) велел перечислить все строки каталога из промпта,
 * #2763 (edff2ff3b) прикладывал 3 карточки и сверял сезон по месяцу без года
 * (заезд 2027 попадал в «осень»), #2764 (797ae51d5) писал паузу проката
 * дважды. Сайт не получал справку «СЕГОДНЯ».
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bookingAgentOwns,
  collapseRepeatedReply,
  commercialSources,
  composeCommercial,
  dropUnsourcedPrices,
  requestButton,
  rubleAmounts,
  telegramOfferLinks,
  type ComposeInput,
} from '@/lib/kuzmich/answer-quality';
import { questionWindow } from '@/lib/telegram/tourist-tours';
import { calendarDay, overlapsWindow, seasonAccusative, windowForMonths } from '@/lib/kuzmich/season-window';
import { pickToursForAnswer, type CatalogTour } from '@/lib/telegram/tourist-tours';

const NOW = new Date('2026-10-24T00:00:00Z');
const BASE = 'https://vedarai.ru';

const AVA: CatalogTour = {
  id: 11,
  slug: 'ava',
  title: 'Восхождение на Авачинский',
  base_price: 15000,
  price_unit: 'per_person',
  multi_day_count: 1,
  activity_type: 'volcano',
  season_start: '2026-09-01',
  season_end: '2026-10-31',
};

const FUTURE: CatalogTour = {
  id: 12,
  slug: 'future',
  title: 'Пять дней 2027',
  base_price: 180000,
  price_unit: 'per_person',
  multi_day_count: 5,
  activity_type: 'volcano',
  season_start: '2027-08-25',
  season_end: '2027-09-30',
};

const PROMPTS = [
  'Какие туры на вулканы есть осенью? Списком с ценами',
  'А сколько стоит первый из них?',
  'Хочу взять машину в аренду',
  'Нужен трансфер из аэропорта Елизово в Петропавловск на 3 человек',
  'Сколько это стоит?',
  'Где остановиться в Паратунке на 3 ночи с горячими источниками?',
  'Сколько стоит первый вариант?',
] as const;

function input(question: string, history: string): ComposeInput {
  return {
    question,
    history,
    now: NOW,
    surface: 'telegram',
    base: BASE,
    pauseActive: true,
    pauseSlugs: ['laguna-prokat'],
    tours: { ok: true, tours: [FUTURE, AVA] },
    transfers: {
      ok: true,
      items: [
        {
          slug: 'laguna-prokat',
          name: 'Лагуна',
          lines: ['Петропавловск-Камчатский 4500 руб за машину'],
          url: `${BASE}/transfers/laguna-prokat#charter-request`,
        },
        {
          slug: 'sever',
          name: 'Север',
          lines: ['Елизово — Петропавловск-Камчатский 7000 руб за машину'],
          url: `${BASE}/transfers/sever#charter-request`,
        },
      ],
    },
    stays: {
      ok: true,
      items: [
        {
          name: 'База в Паратунке',
          priceText: 'от 4000 руб/ночь',
          url: `${BASE}/accommodations/p1`,
          zone: 'Паратунка',
          mentionsSprings: true,
        },
        {
          name: 'Дом в Елизово',
          priceText: 'от 9000 руб/ночь',
          url: `${BASE}/accommodations/e1`,
          zone: 'Елизово',
          mentionsSprings: false,
        },
      ],
    },
  };
}

function script(): string[] {
  let history = '';
  const answers: string[] = [];
  for (const question of PROMPTS) {
    const answer = composeCommercial(input(question, history));
    expect(answer, question).not.toBeNull();
    answers.push(answer!.visible);
    history = `${history}\n\n${answer!.visible}`;
  }
  return answers;
}

function namedLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '));
}

describe('семь вопросов подряд', () => {
  const answers = script();

  it('осень 2026: живой тур с ценой и ссылкой, заезд 2027 не доступен', () => {
    const text = answers[0]!;
    expect(text).toContain('Восхождение на Авачинский');
    expect(text).toContain(`${BASE}/catalog/tours/ava`);
    expect(text).toMatch(/15\s*000/);
    expect(text).not.toContain('Пять дней 2027');
    expect(text).not.toContain('180');
    expect(text).not.toContain('2027');
    expect(text).toContain('Отправить запрос оператору');
    expect(text).toContain('в этот чат не пишите');
    expect(rubleAmounts(text)).toEqual([15000]);
    const lines = namedLines(text);
    expect(lines).toHaveLength(1);
    expect(lines.every((line) => line.includes('https://'))).toBe(true);
  });

  it('первый из списка — цена того тура, без новой', () => {
    const text = answers[1]!;
    expect(text).toContain('Восхождение на Авачинский');
    expect(text).toMatch(/15\s*000/);
    expect(text).toContain(`${BASE}/catalog/tours/ava`);
    expect(text).not.toContain('180');
    expect(text).toContain('Отправить запрос оператору');
    expect(rubleAmounts(text)).toEqual([15000]);
  });

  it('аренда на паузе — одна фраза, без цены и без Лагуны', () => {
    const text = answers[2]!;
    expect(text).toContain('не показывается');
    expect(text).not.toMatch(/Лагуна/i);
    expect(rubleAmounts(text)).toEqual([]);
    expect(text).not.toContain('Отправить запрос');
    expect(text.split('vedarai.ru/transfers').length - 1).toBe(1);
    const pause = text.split('не показывается').length - 1;
    expect(pause).toBe(1);
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    expect(new Set(paragraphs).size).toBe(paragraphs.length);
  });

  it('трансфер: цена за машину из прайса, Лагуна скрыта, на троих не умножается', () => {
    const text = answers[3]!;
    expect(text).toContain('Север');
    expect(text).toContain('7000 руб');
    expect(text).toContain(`${BASE}/transfers/sever#charter-request`);
    expect(text).not.toContain('4500');
    expect(text).not.toContain('21000');
    expect(text).not.toContain('21 000');
    expect(text).not.toMatch(/Лагуна/i);
    expect(text).toContain('за машину');
    expect(text).toContain('сумму не считаю');
    expect(text).toContain('Отправить запрос перевозчику');
    expect(rubleAmounts(text)).toEqual([7000]);
    expect(namedLines(text).every((line) => line.includes('https://'))).toBe(true);
  });

  it('сколько это стоит — цена той машины, не новая', () => {
    const text = answers[4]!;
    expect(text).toContain('7000 руб');
    expect(text).toContain(`${BASE}/transfers/sever#charter-request`);
    expect(text).not.toContain('4500');
    expect(text).toContain('Отправить запрос перевозчику');
    expect(rubleAmounts(text)).toEqual([7000]);
  });

  it('Паратунка: цена за сутки, не за 3 ночи, чужой посёлок не подставлен', () => {
    const text = answers[5]!;
    expect(text).toContain('База в Паратунке');
    expect(text).toContain('4000 руб/ночь');
    expect(text).toContain(`${BASE}/accommodations/p1`);
    expect(text).not.toContain('9000');
    expect(text).not.toContain('12000');
    expect(text).not.toContain('12 000');
    expect(text).toContain('за сутки');
    expect(text).toContain('не считаю');
    expect(text).toContain('Отправить запрос владельцу жилья');
    expect(rubleAmounts(text)).toEqual([4000]);
    expect(namedLines(text).every((line) => line.includes('https://'))).toBe(true);
  });

  it('первый вариант жилья — его цена', () => {
    const text = answers[6]!;
    expect(text).toContain('База в Паратунке');
    expect(text).toContain('4000 руб/ночь');
    expect(text).toContain(`${BASE}/accommodations/p1`);
    expect(text).not.toContain('9000');
    expect(text).toContain('Отправить запрос владельцу жилья');
    expect(rubleAmounts(text)).toEqual([4000]);
  });
});

describe('прод 24.10, сборка 19:53Z: двенадцать туров и три карточки', () => {
  const prodPrompt = 'Какие туры на вулканы есть осенью? Перечисли списком с ценами';

  function volcano(partial: Partial<CatalogTour> & Pick<CatalogTour, 'id' | 'title' | 'base_price'>): CatalogTour {
    return {
      slug: `t-${partial.id}`,
      price_unit: 'per_person',
      multi_day_count: 1,
      activity_type: 'volcano',
      season_start: '2026-09-01',
      season_end: '2026-11-30',
      ...partial,
    };
  }

  it('Ключевская вне осени не названа, у каждого тура ссылка и та же карточка', () => {
    const klyuchevskaya = volcano({
      id: 1,
      slug: 'klyuchevskaya',
      title: 'Ключевская сопка',
      base_price: 320000,
      season_start: '2026-07-01',
      season_end: '2026-08-20',
    });
    const nextAutumn = Array.from({ length: 8 }, (_, i) => volcano({
      id: 10 + i,
      title: `Заезд ${i} следующего года`,
      base_price: 510000 + i,
      season_start: '2027-08-25',
      season_end: '2027-09-30',
    }));
    const live = [
      volcano({ id: 2, slug: 'ava', title: 'Авачинский осенью', base_price: 15000 }),
      volcano({ id: 3, slug: 'gorely', title: 'Горелый осенью', base_price: 42000 }),
      volcano({ id: 4, slug: 'mutnovsky', title: 'Мутновский осенью', base_price: 88000 }),
    ];
    const answer = composeCommercial({
      ...input(prodPrompt, ''),
      tours: { ok: true, tours: [klyuchevskaya, ...nextAutumn, ...live] },
    });
    expect(answer).not.toBeNull();
    const text = answer!.visible;
    expect(text).not.toMatch(/Ключевск/);
    expect(text).not.toMatch(/320\s*000/);
    expect(text).not.toContain('2027');
    expect(text).not.toContain('этого заезда нет');
    const lines = namedLines(text);
    expect(lines).toHaveLength(answer!.tours.length);
    expect(lines.every((line) => /https:\/\/vedarai\.ru\/catalog\/tours\//.test(line))).toBe(true);
    expect(answer!.tours.map((tour) => tour.slug)).toEqual(['ava', 'gorely', 'mutnovsky']);
    expect(rubleAmounts(text).sort((a, b) => a - b)).toEqual([15000, 42000, 88000]);
  });

  it('двенадцать живых: цена только у тура со ссылкой, остальные без названия и цены', () => {
    const dozen = Array.from({ length: 12 }, (_, i) => volcano({
      id: 100 + i,
      slug: `live-${i}`,
      title: `Осенний тур ${i}`,
      base_price: 10000 * (i + 1),
    }));
    const answer = composeCommercial({
      ...input(prodPrompt, ''),
      tours: { ok: true, tours: dozen },
    });
    expect(answer).not.toBeNull();
    const lines = namedLines(answer!.visible);
    expect(lines).toHaveLength(8);
    expect(lines).toHaveLength(answer!.tours.length);
    expect(lines.every((line) => line.includes('https://'))).toBe(true);
    expect(rubleAmounts(answer!.visible)).toEqual(dozen.slice(0, 8).map((tour) => Number(tour.base_price)));
    expect(answer!.visible).toContain('Ещё 4');
    for (const hidden of dozen.slice(8)) {
      expect(answer!.visible).not.toContain(hidden.title);
      expect(rubleAmounts(answer!.visible)).not.toContain(Number(hidden.base_price));
    }
  });
});

describe('Telegram 25.10.2026: дешёвые туры со ссылкой, чужой сезон и вторая фраза проката', () => {
  const NOW_25 = new Date('2026-10-24T12:00:00.000Z');

  function volcano(partial: Partial<CatalogTour> & Pick<CatalogTour, 'id' | 'title' | 'base_price'>): CatalogTour {
    return {
      slug: `t-${partial.id}`,
      price_unit: 'per_person',
      multi_day_count: 1,
      activity_type: 'volcano',
      season_start: '2026-09-01',
      season_end: '2026-11-30',
      ...partial,
    };
  }

  it('окно осени начинается с сегодня, заезд до 25 октября не идёт', () => {
    const autumn = questionWindow('Какие туры на вулканы есть осенью?', NOW_25);
    expect(autumn).toEqual({ start: '2026-10-25', end: '2026-11-30', label: 'осень 2026' });
  });

  it('Горелый, Дачные и перевал — с ценой и ссылкой; Ключевская и вертолёт до октября 2027 — нет', () => {
    const answer = composeCommercial({
      ...input('Какие туры на вулканы есть осенью? Перечисли списком с ценами', ''),
      now: NOW_25,
      tours: {
        ok: true,
        tours: [
          volcano({ id: 1, slug: 'klyuchevskaya', title: 'Ключевская сопка', base_price: 320000, season_start: '2026-07-01', season_end: '2026-09-30' }),
          volcano({ id: 2, slug: 'heli', title: 'Вертолёт к вулканам', base_price: 180000, activity_type: 'helicopter', season_start: '2027-06-01', season_end: '2027-10-01' }),
          volcano({ id: 3, slug: 'gorely', title: 'Горелый', base_price: 15000 }),
          volcano({ id: 4, slug: 'dachnye', title: 'Дачные источники', base_price: 18000 }),
          volcano({ id: 5, slug: 'avacha-pass', title: 'Авачинский перевал', base_price: 22000 }),
        ],
      },
    });
    expect(answer).not.toBeNull();
    const text = answer!.visible;
    expect(text).not.toMatch(/Ключевск|Вертолёт/);
    expect(text).not.toMatch(/320\s*000|180\s*000/);
    expect(text).not.toMatch(/сезон до/);
    expect(text).not.toContain('2027');
    expect(text).not.toMatch(/ноябр/i);
    const lines = namedLines(text);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => /https:\/\/vedarai\.ru\/catalog\/tours\//.test(line))).toBe(true);
    expect(answer!.tours.map((tour) => tour.slug)).toEqual(['gorely', 'dachnye', 'avacha-pass']);
    const linked = telegramOfferLinks(text);
    expect(linked).toContain('<a href="https://vedarai.ru/catalog/tours/gorely">Горелый</a>');
    expect(linked).toContain('<a href="https://vedarai.ru/catalog/tours/dachnye">Дачные источники</a>');
    expect(linked).toContain('<a href="https://vedarai.ru/catalog/tours/avacha-pass">Авачинский перевал</a>');
    expect(linked).not.toMatch(/320/);
  });

  it('две формулировки паузы с одной ссылкой схлопываются в одну', () => {
    const doubled = [
      'Прокат автомобилей без водителя на сайте сейчас не показывается — вернётся во вторник, 27 октября. Машину с водителем можно смотреть у перевозчиков: https://vedarai.ru/transfers',
      'Витрина проката скрыта до 27 октября. Отправить запрос перевозчику: https://vedarai.ru/transfers',
    ].join('\n\n');
    const once = collapseRepeatedReply(doubled);
    expect(once.split('не показывается').length - 1).toBe(1);
    expect(once.split('vedarai.ru/transfers').length - 1).toBe(1);
    expect(once).not.toContain('Отправить запрос');
  });
});

describe('оценка и пауза источника', () => {
  it('вилка-ориентир вырезается, цена из источника остаётся', () => {
    const dropped = dropUnsourcedPrices('Ориентир на человека: 4 500–6 750 ₽.', 'от 15 000 ₽/чел.');
    expect(dropped.dropped).toBe(true);
    expect(dropped.text).not.toMatch(/4\s*500/);
    expect(dropped.text).not.toMatch(/6\s*750/);
    expect(dropped.text).toContain('не называю');
    const kept = dropUnsourcedPrices('Цена: от 15 000 ₽.', 'от 15 000 ₽/чел.');
    expect(kept.dropped).toBe(false);
    expect(kept.text).toMatch(/15\s*000/);
  });

  it('два перевозчика и «сколько это стоит» — вопрос, без новой цены', () => {
    const listed = composeCommercial({
      ...input('Нужен трансфер из аэропорта Елизово', ''),
      pauseActive: false,
      pauseSlugs: [],
      transfers: {
        ok: true,
        items: [
          { slug: 'a', name: 'Альфа', lines: ['Елизово 5000 руб за машину'], url: `${BASE}/transfers/a#charter-request` },
          { slug: 'b', name: 'Бета', lines: ['Елизово 8000 руб за машину'], url: `${BASE}/transfers/b#charter-request` },
        ],
      },
    });
    const follow = composeCommercial({
      ...input('Сколько это стоит?', listed!.visible),
      pauseActive: false,
    });
    expect(follow!.visible).toContain('несколько вариантов');
    expect(rubleAmounts(follow!.visible)).toEqual([]);
    expect(follow!.visible).toContain('Отправить запрос перевозчику');
  });

  it('Елизово — Петропавловск: тариф Желтухина со ссылкой, Лагуна на паузе скрыта', () => {
    const listed = composeCommercial({
      ...input('Нужен трансфер из аэропорта Елизово в Петропавловск на 3 человек', ''),
      transfers: {
        ok: true,
        items: [
          {
            slug: 'zheltukhin',
            name: 'ИП Желтухин',
            lines: ['4500 руб за час работы машины'],
            url: `${BASE}/transfers/zheltukhin#charter-request`,
          },
          {
            slug: 'laguna-prokat',
            name: 'Лагуна Прокат',
            lines: ['25000 руб за полный день работы машины'],
            url: `${BASE}/transfers/laguna-prokat#charter-request`,
          },
        ],
      },
    });
    const text = listed!.visible;
    expect(text).toContain('ИП Желтухин');
    expect(text).toContain('4500 руб за час работы машины');
    expect(text).toContain(`${BASE}/transfers/zheltukhin#charter-request`);
    expect(text).not.toMatch(/Лагуна/i);
    expect(text).not.toContain('25000');
    expect(text).not.toMatch(/6\s*750/);
    expect(text).toContain('сумму не считаю');
    expect(namedLines(text).every((line) => line.includes('https://'))).toBe(true);
    expect(requestButton(text)).toEqual({
      text: 'Отправить запрос перевозчику',
      url: `${BASE}/transfers/zheltukhin#charter-request`,
    });
    const follow = composeCommercial(input('Сколько это стоит?', text));
    expect(follow!.visible).toContain('4500 руб за час работы машины');
    expect(follow!.visible).toContain(`${BASE}/transfers/zheltukhin#charter-request`);
    expect(follow!.visible).not.toMatch(/6\s*750/);
    expect(follow!.visible).not.toMatch(/4\s*500\s*[–—-]\s*6/);
    expect(follow!.visible).not.toMatch(/Лагуна/i);
    expect(rubleAmounts(follow!.visible)).toEqual([4500]);
  });

  it('пустая Паратунка не отдаёт «первый вариант» джипу из прошлого списка', () => {
    const jeep = composeCommercial(input('Какие туры на вулканы есть осенью? Списком с ценами', ''));
    const stay = composeCommercial({
      ...input('Где остановиться в Паратунке на 3 ночи с горячими источниками?', jeep!.visible),
      stays: { ok: true, items: [] },
    });
    expect(stay!.visible).toContain('Жильё из витрины');
    expect(stay!.visible).toContain('по Паратунке ничего нет');
    expect(stay!.visible).toContain('Отправить запрос владельцам жилья');
    expect(stay!.visible).toContain(`${BASE}/accommodations`);
    expect(stay!.visible).not.toContain('Авачинский');
    expect(requestButton(stay!.visible)?.url).toBe(`${BASE}/accommodations`);
    const follow = composeCommercial(input('Сколько стоит первый вариант?', `${jeep!.visible}\n\n${stay!.visible}`));
    expect(follow!.visible).toContain('жильё');
    expect(follow!.visible).not.toContain('Авачинский');
    expect(follow!.visible).not.toMatch(/15\s*000/);
    expect(follow!.visible).toContain(`${BASE}/accommodations`);
    expect(rubleAmounts(follow!.visible)).toEqual([]);
  });

  it('«где жить» и «что посмотреть» читают свою витрину, не пустой список', () => {
    expect(commercialSources('Где жить в Елизово на 2 ночи?')).toMatchObject({
      tours: false,
      stays: true,
      stayZones: ['елизов'],
    });
    expect(commercialSources('Что посмотреть за 5 дней в июле?').tours).toBe(true);
    expect(commercialSources('Где остановиться в Паратунке?').stayZones).toEqual(['паратунк']);
  });

  it('Лагуна на паузе не попадает в туры', () => {
    const paused: CatalogTour = { ...AVA, id: 3, slug: 'laguna', title: 'Джип Лагуны', operator_slug: 'laguna-prokat' };
    const picked = pickToursForAnswer(
      'Какие туры на вулканы есть осенью?',
      { ok: true, tours: [paused, AVA] },
      NOW,
    );
    expect(picked.tours.map((tour) => tour.slug)).toEqual(['ava']);
  });

  it('осень 24.10.2026 — окно 2026, заезд 2027 мимо', () => {
    const today = calendarDay(NOW);
    const autumn = windowForMonths([9, 10, 11], today);
    expect(autumn).toEqual({ start: '2026-09-01', end: '2026-11-30', label: 'осень 2026' });
    expect(overlapsWindow(FUTURE.season_start, FUTURE.season_end, autumn)).toBe(false);
    expect(overlapsWindow(AVA.season_start, AVA.season_end, autumn)).toBe(true);
  });
});

describe('окно без идущих туров и падеж сезона', () => {
  const NOW_25 = new Date('2026-10-24T12:00:00.000Z');

  it('«на» и «про» ставят зиму и весну в винительный', () => {
    expect(seasonAccusative('зима 2026–2027')).toBe('зиму 2026–2027');
    expect(seasonAccusative('весна 2027')).toBe('весну 2027');
    expect(seasonAccusative('осень 2026')).toBe('осень 2026');
    expect(seasonAccusative('лето 2027')).toBe('лето 2027');
  });

  it('осень 25.10: идущих туров нет — ближайший сезон и запрос, не «доступен сейчас»', () => {
    const ended: CatalogTour = {
      id: 1,
      slug: 'klyuchevskaya',
      title: 'Ключевская сопка',
      base_price: 320000,
      price_unit: 'per_person',
      multi_day_count: 1,
      activity_type: 'volcano',
      season_start: '2026-07-01',
      season_end: '2026-09-30',
    };
    const answer = composeCommercial({
      ...input('Какие туры на вулканы есть осенью?', ''),
      now: NOW_25,
      tours: { ok: true, tours: [ended] },
    });
    const text = answer!.visible;
    expect(text).toContain('На осень 2026');
    expect(text).toContain('25 октября 2026');
    expect(text).toContain('30 ноября 2026');
    expect(text).toContain('нет тура, который идёт');
    expect(text).toContain('Ключевская сопка');
    expect(text).toContain('сезон 1 июля 2026 — 30 сентября 2026');
    expect(text).toContain(`${BASE}/catalog/tours/klyuchevskaya`);
    expect(text).toContain('в это окно не попадают');
    expect(text).toContain('Доступными в названное окно их не называю');
    expect(text).toContain('Цену не называю');
    expect(text).not.toMatch(/320\s*000/);
    expect(requestButton(text)).toEqual({
      text: 'Отправить запрос оператору',
      url: `${BASE}/catalog/tours/klyuchevskaya`,
    });
  });

  it('список на зиму говорит «на зиму», не «на зима»', () => {
    const snow: CatalogTour = {
      id: 9,
      slug: 'snow',
      title: 'Снегоходная прогулка',
      base_price: 25000,
      price_unit: 'per_person',
      multi_day_count: 1,
      activity_type: 'snowmobile',
      season_start: '2026-12-01',
      season_end: '2027-02-28',
    };
    const listed = composeCommercial({
      ...input('Какие туры есть зимой?', ''),
      now: NOW_25,
      tours: { ok: true, tours: [snow] },
    });
    expect(listed!.visible).toContain('на зиму 2026–2027');
    expect(listed!.visible).not.toContain('на зима');
    expect(listed!.visible).toContain('Снегоходная прогулка');

    const none = composeCommercial({
      ...input('Какие туры есть зимой?', ''),
      now: NOW_25,
      tours: { ok: true, tours: [] },
    });
    expect(none!.visible).toContain('На зиму 2026–2027');
    expect(none!.visible).not.toContain('На зима');
    expect(none!.visible).toContain('Отправить запрос оператору');
    expect(requestButton(none!.visible)?.url).toBe(`${BASE}/catalog`);
  });
});

describe('не коммерция — отвечает модель', () => {
  it('вопрос про место и «первый вопрос» списком не становятся', () => {
    for (const question of [
      'Когда лучше идти на Авачинский вулкан?',
      'первый вопрос про тропу',
      'Что взять в поход на вулкан?',
    ]) {
      expect(composeCommercial(input(question, '')), question).toBeNull();
    }
  });

  it('«хочу тур» — агент брони, не сборщик списка', () => {
    expect(bookingAgentOwns('Хочу тур на вулкан 15 июля')).toBe(true);
    expect(bookingAgentOwns('Какие туры на вулканы есть осенью? Списком с ценами')).toBe(false);
    expect(bookingAgentOwns('Хочу взять машину в аренду')).toBe(false);
  });
});

describe('один сборщик на сайт, Telegram и MAX', () => {
  it('вебхук не дописывает паузу к ответу модели', () => {
    const src = readFileSync('app/api/telegram/webhook/route.ts', 'utf8');
    const fn = src.slice(src.indexOf('async function answerByKuzmich'), src.indexOf('async function answerTouristButton'));
    expect(fn).not.toContain('pauseLine');
    expect(fn).toContain('aiChat');
  });

  it('сайт и мозг мессенджеров зовут один сборщик', () => {
    const web = readFileSync('app/api/ai/chat/route.ts', 'utf8');
    const core = readFileSync('lib/kuzmich/core.ts', 'utf8');
    const max = readFileSync('app/api/max/kuzmich/route.ts', 'utf8');
    expect(web).toContain('resolveCommercialTurn');
    expect(web).toContain('kamchatkaDateContext');
    expect(core).toContain('resolveCommercialTurn');
    expect(max).toContain('processMessage');
  });
});
