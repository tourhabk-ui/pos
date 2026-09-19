/**
 * Кузьмич выдаёт план поездки в чате («Мой план 2.0», A-2; владелец 08.08:
 * «план мне нравится, реализуем»).
 *
 * Паттерн GuideGeek (планировщик в мессенджере), доведённый до сделки:
 * ответ Кузьмича — план по дням из движка + ссылка на публичную страницу
 * /plans/[slug] с бронью реальных туров. Персональной ссылки сознательно
 * нет: user_trips.user_id NOT NULL, анонимный share требовал бы миграцию.
 *
 * Сторож держит: инструмент зарегистрирован и звётся из core, интересы
 * парсятся из свободного русского текста, подбор пресета честный,
 * форматтер не падает на пустом плане.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseChatInterests, matchPreset, formatTripPlanForChat,
  buildRefusal, inSeasonInterests,
} from '@/lib/kuzmich/trip-plan-tool';
import { KUZMICH_TOOLS, validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import type { DayPlan } from '@/lib/planner';

const ROOT = process.cwd();
const CORE = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Авачинский вулкан',
  description: '', activityType: 'volcano', priceFrom: 8500, priceTo: 12000,
  coords: [53.25, 158.75], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'moderate' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...over,
});

describe('parseChatInterests: свободный русский текст → ключи движка', () => {
  it('понимает разговорные формулировки', () => {
    const keys = parseChatInterests('хотим вулканы, медведей и в конце на море');
    expect(keys).toContain('volcano');
    expect(keys).toContain('bears');
    expect(keys).toContain('boat_trip');
  });

  it('пусто → классика первой поездки, не пустой план', () => {
    expect(parseChatInterests('')).toEqual(['volcano', 'bears', 'thermal']);
  });
});

describe('matchPreset: ссылка на публичную страницу с бронью', () => {
  it('неделя с вулканами → недельный вулканический пресет', () => {
    const p = matchPreset(7, ['volcano', 'trekking', 'thermal']);
    expect(p?.slug).toBe('kamchatka-za-7-dney-vulkany');
  });

  it('интересы без пересечения с пресетами → без ссылки, а не наугад', () => {
    // geyser — ключ движка, которого нет ни в одном пресете. Раньше здесь был
    // snowmobile, но зимний кластер (kamchatka-zimoy) его законно покрыл.
    expect(matchPreset(7, ['geyser'])).toBeNull();
  });

  it('снегоходы → зимний кластер (появился с посадочными)', () => {
    expect(matchPreset(7, ['snowmobile'])?.slug).toBe('kamchatka-zimoy');
  });
});

describe('formatTripPlanForChat', () => {
  it('план по дням с ценами, предупреждением и обеими ссылками', () => {
    const text = formatTripPlanForChat(
      [day({}), day({ day: 2, title: 'Паратунка', activityType: 'thermal', priceFrom: 1500 })],
      ['Сентябрь — штормовой сезон на воде.'],
      { slug: 'kamchatka-za-7-dney-vulkany', title: 'x' },
    );
    // Разделитель тысяч в ru-RU — неразрывный пробел, не привязываемся к нему.
    expect(text).toMatch(/День 1\. Авачинский вулкан — от 8.500.₽/);
    expect(text).toContain('День 2. Паратунка');
    expect(text).toContain('Важно: Сентябрь');
    expect(text).toContain('/plans/kamchatka-za-7-dney-vulkany');
    expect(text).toContain('/planner');
  });

  it('пустой план — честный ответ со ссылкой на планировщик, не тишина', () => {
    const text = formatTripPlanForChat([], [], null);
    expect(text).toContain('Не собрал план');
    expect(text).toContain('/planner');
  });

  it('дата, на которую считали, названа в плане', () => {
    // Турист просит «семь дней», а движок молча берёт месяц вперёд. Не
    // назвать дату значит выдать план на октябрь за план «на сейчас».
    const text = formatTripPlanForChat([day({})], [], null, {
      refusal: 'x', plannedFor: '19 октября',
    });
    expect(text).toContain('19 октября');
  });

  it('готовый отказ не подменяется вшитой строкой', () => {
    const text = formatTripPlanForChat([], [], null, {
      refusal: 'В октябре это уже не сезон: вулканы.', plannedFor: '19 октября',
    });
    expect(text).toBe('В октябре это уже не сезон: вулканы.');
  });
});

/**
 * Отказ собрать план — замер с прода 19.09.
 *
 * Прежний текст был вшит строкой: «попробуй назвать интересы иначе (вулканы,
 * рыбалка, медведи, море)». Планировщик считает поездку на `now + 30 дней`,
 * то есть в сентябре — на октябрь, а в октябре вулканы, рыбалка и медведи уже
 * вне сезонных окон движка. Три слова совета из четырёх вели обратно в тот же
 * отказ, и настоящая причина — месяц — не называлась вовсе.
 */
describe('отказ называет причину, а не гоняет по кругу', () => {
  it('в сезоне считается из окон движка, а не из списка в коде', () => {
    // Октябрь: вулканы/рыбалка/медведи закрыты, море и термалка идут.
    const october = inSeasonInterests(10);
    expect(october).toContain('boat_trip');
    expect(october).toContain('thermal');
    expect(october).not.toContain('volcano');
    expect(october).not.toContain('fishing');
    expect(october).not.toContain('bears');
    // Январь — другой набор, и он тоже не пуст: «ничего» было бы неправдой.
    expect(inSeasonInterests(1)).toContain('snowmobile');
    expect(inSeasonInterests(1)).not.toContain('boat_trip');
  });

  it('называет месяц и то, что именно не в сезоне', () => {
    const text = buildRefusal(10, ['volcano', 'bears'], 'https://vedarai.ru');
    expect(text).toContain('октябре');
    expect(text).toContain('вулканы');
    expect(text).toContain('медведи');
  });

  it('совет не повторяет то, на чём план и не собрался', () => {
    // Главный дефект прежнего текста: закрытое в этом месяце предлагалось
    // назвать снова.
    const text = buildRefusal(10, ['volcano', 'fishing', 'bears'], 'https://vedarai.ru');
    const advice = text.slice(text.indexOf('Что идёт'));
    for (const closed of ['вулканы', 'рыбалка', 'медведи']) {
      expect(advice, `${closed} снова в совете`).not.toContain(closed);
    }
    expect(advice).toContain('морские прогулки');
  });

  it('интересы в сезоне — отказ не врёт про сезон', () => {
    // План может не сложиться и по другой причине (нет туров, транспорт).
    // Тогда говорить «не сезон» про конкретные интересы нельзя.
    const text = buildRefusal(8, ['volcano'], 'https://vedarai.ru');
    expect(text).toContain('план не сложился');
    expect(text).not.toContain('уже не сезон');
  });

  it('ссылка на живой планировщик остаётся — там задают свои даты', () => {
    expect(buildRefusal(10, ['volcano'], 'https://vedarai.ru')).toContain('https://vedarai.ru/planner');
  });

  it('обработчик считает месяц от даты, на которую планирует', () => {
    // Иначе отказ назовёт сезон «сегодня», а план считался на месяц вперёд.
    const src = readFileSync(join(ROOT, 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
    expect(src).toMatch(/const month = arrival\.getUTCMonth\(\) \+ 1/);
    expect(src).toContain('buildRefusal(month');
    // Вшитого перечня интересов в отказе больше нет.
    expect(src).not.toContain('назвать интересы иначе');
  });
});

describe('инструмент подключён', () => {
  it('make_trip_plan зарегистрирован и виден модели', () => {
    const names = KUZMICH_TOOLS.map((t) => t.function.name);
    expect(names).toContain('make_trip_plan');
  });

  it('аргументы валидируются: оба необязательны, мусор не проходит', () => {
    expect(validateToolArgs('make_trip_plan', {}).ok).toBe(true);
    expect(validateToolArgs('make_trip_plan', { days: '7', interests: 'вулканы' }).ok).toBe(true);
  });

  it('core зовёт обработчик', () => {
    expect(CORE).toMatch(/makeTripPlanForKuzmich/);
  });
});
