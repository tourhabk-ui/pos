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
  composeCommercial,
  dropUnsourcedPrices,
  rubleAmounts,
  type ComposeInput,
} from '@/lib/kuzmich/answer-quality';
import { calendarDay, overlapsWindow, windowForMonths } from '@/lib/kuzmich/season-window';
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
    expect(text).toContain('Отправить запрос перевозчику');
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
