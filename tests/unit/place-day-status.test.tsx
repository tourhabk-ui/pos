/**
 * Обстановка у места на сегодня — одно правило на полосу «Сейчас», совет
 * Кузьмича на карточке и чат Кузьмича (15.10, §0 «честность»).
 *
 * До этого дня полоса писала «Сегодня можно идти» и «Запретов и
 * предупреждений нет» почти у всех мест: уровень считался по `is_open = TRUE`
 * (значение по умолчанию у всех мест) и по своей шкале, где действующее
 * предупреждение уровня 1 печаталось под «предупреждений нет», а критичное (2)
 * — «идти можно, но осторожно». Совет Кузьмича строкой ниже говорил своё.
 *
 * Судится вызовом и рендером: что человек видит в полосе и в совете.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PlaceRealtimeStatus from '@/components/places/PlaceRealtimeStatus';
import type { PlaceRealtime } from '@/components/places/types';
import {
  placeDayStatus, placeStatusFields, PLACE_STATUS_FRESH_MS, kamchatkaStamp, PARK_SEASON_ANSWER, PARK_SEASON_NOTE,
} from '@/lib/safety/place-day-status';
import { tourPlaceStatus, tourPlaceStatusLine } from '@/lib/safety/tour-place-status';
import { isBareParkClosure, isSeasonalClosure } from '@/lib/safety/park-closure';
import { seasonalClosureIdsOf } from '@/lib/services/safety/park-season';
import { buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';

afterEach(cleanup);

const NOW = Date.parse('2026-10-15T08:00:00.000Z');
const FRESH = new Date(NOW - 10 * 60 * 1000).toISOString();
const STALE = new Date(NOW - PLACE_STATUS_FRESH_MS - 60 * 1000).toISOString();

const rt = (over: Partial<PlaceRealtime> = {}): PlaceRealtime => ({
  isOpen: true, currentCrowds: null, currentWeather: null, activeAlerts: [], alertSeverity: 0,
  alertMessage: null, touristsToday: null, touristsHour: null,
  status: 'green', linkedVolcanoes: null, updatedAt: FRESH,
  ...over,
});

const strip = (r: PlaceRealtime, extra: { isVolcano?: boolean; volcanoColor?: string | null } = {}) => {
  render(<PlaceRealtimeStatus realtime={r} now={NOW} {...extra} />);
  return screen.getByRole('status').textContent ?? '';
};

describe('правило дня: placeDayStatus', () => {
  it('закрытие ставит человек — оно не протухает вместе с пересчётом', () => {
    expect(placeDayStatus({ isOpen: false, status: 'green', updatedAt: STALE }, NOW)).toEqual({ level: 'closed', stale: false });
    expect(placeDayStatus({ isOpen: false, status: null, updatedAt: null }, NOW).level).toBe('closed');
  });

  it('NULL в is_open — не «закрыто»: уровень решает пересчёт', () => {
    expect(placeDayStatus({ isOpen: null, status: 'yellow', updatedAt: FRESH }, NOW).level).toBe('yellow');
  });

  it('цвет пересчёта — только свежий', () => {
    expect(placeDayStatus({ isOpen: true, status: 'red', updatedAt: FRESH }, NOW).level).toBe('red');
    expect(placeDayStatus({ isOpen: true, status: 'green', updatedAt: STALE }, NOW)).toEqual({ level: 'unknown', stale: true });
  });

  it('нет пересчёта или непонятный статус — «не знаем», а не зелёный', () => {
    expect(placeDayStatus({ isOpen: true, status: 'green', updatedAt: null }, NOW)).toEqual({ level: 'unknown', stale: false });
    expect(placeDayStatus({ isOpen: true, status: null, updatedAt: FRESH }, NOW).level).toBe('unknown');
    expect(placeDayStatus({ isOpen: true, status: 'purple', updatedAt: FRESH }, NOW).level).toBe('unknown');
  });

  it('время — по Камчатке, независимо от пояса читающего', () => {
    // 08:00 UTC = 20:00 по Камчатке (UTC+12).
    expect(kamchatkaStamp('2026-10-15T08:00:00.000Z')).toMatch(/20:00/);
  });
});

describe('полоса «Сейчас»: что видит человек', () => {
  it('зелёный — «предупреждений нет» и прямо: это не проверка места; разрешения не даёт', () => {
    const text = strip(rt());
    expect(text).toContain('Предупреждений по месту нет');
    expect(text).toContain('не проверка самого места');
    expect(text).not.toMatch(/можно идти|Запретов и предупреждений нет/i);
  });

  it('действующее предупреждение под зелёным не прячется под «предупреждений нет»', () => {
    const text = strip(rt({ activeAlerts: ['Вилючинский перевал — проезд по пропускам'], alertSeverity: 1 }));
    expect(text).toContain('Серьёзных предупреждений нет');
    expect(text).toContain('Вилючинский перевал — проезд по пропускам');
    expect(text).not.toContain('Предупреждений по месту нет');
  });

  it('жёлтый пересчёта — предупреждение с заголовком из сводки', () => {
    const text = strip(rt({ status: 'yellow', activeAlerts: ['Паводок на реке Камчатка'], alertSeverity: 2 }));
    expect(text).toContain('Есть предупреждение');
    expect(text).toContain('Паводок на реке Камчатка');
    expect(text).not.toMatch(/можно/i);
  });

  it('красный пересчёта — «опасно», самое опасное предупреждение первым', () => {
    render(<PlaceRealtimeStatus realtime={rt({ status: 'red', activeAlerts: ['Сход селя', 'Ограничение проезда'], alertSeverity: 2 })} now={NOW} />);
    const lines = screen.getAllByText(/Сход селя|Ограничение проезда/).map((n) => n.textContent);
    expect(screen.getByRole('status').textContent).toContain('Сегодня там опасно');
    expect(lines).toEqual(['Сход селя', 'Ограничение проезда']);
  });

  it('красный без заголовков у вулкана — причина названа шкалой вулкана, не выдумана', () => {
    expect(strip(rt({ status: 'red', activeAlerts: [] }), { isVolcano: true, volcanoColor: 'orange' }))
      .toContain('Код вулкана KVERT — оранжевый');
    cleanup();
    expect(strip(rt({ status: 'yellow', activeAlerts: [], linkedVolcanoes: 'Мутновский' })))
      .toContain('Место у вулкана Мутновский');
    cleanup();
    expect(strip(rt({ status: 'red', activeAlerts: [] }))).toContain('Причину пересчёт не записал');
  });

  it('закрыто администратором — «закрыто», с его причиной или словами, что её нет', () => {
    expect(strip(rt({ isOpen: false, alertMessage: 'Тропа размыта' }))).toMatch(/Закрыто для посещения.*Тропа размыта/);
    cleanup();
    expect(strip(rt({ isOpen: false }))).toContain('Причина не записана');
  });

  it('NULL в is_open не читается как «закрыто»', () => {
    expect(strip(rt({ isOpen: null }))).not.toContain('Закрыто');
  });

  it('пересчёт встал — цвета нет, сказано почему; прежнее предупреждение не теряется', () => {
    const text = strip(rt({ updatedAt: STALE, activeAlerts: ['Сход селя'] }));
    expect(text).toContain('Обстановку сейчас не знаем');
    expect(text).toContain('давно не обновлялся');
    expect(text).toContain('В последнем пересчёте: Сход селя');
    expect(text).not.toContain('Предупреждений по месту нет');
  });

  it('свежесть видна словами того, что было, — пересчёт сводок, а не «проверили»', () => {
    const text = strip(rt({ updatedAt: '2026-10-15T07:50:00.000Z' }));
    expect(text).toContain('Сводки пересчитаны 15.10, 19:50 по Камчатке');
    expect(text).not.toContain('Проверили');
    cleanup();
    expect(strip(rt({ updatedAt: null }))).toContain('Когда пересчитывали — у нас не записано');
  });

  it('красный и закрытое липнут к верху при прокрутке, зелёный — нет', () => {
    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
      fireEvent.scroll(window);
    };
    render(<PlaceRealtimeStatus realtime={rt({ status: 'red', activeAlerts: ['Сход селя'] })} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).toContain('sticky');
    cleanup();
    render(<PlaceRealtimeStatus realtime={rt({ isOpen: false })} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).toContain('sticky');
    cleanup();
    render(<PlaceRealtimeStatus realtime={rt()} now={NOW} />);
    scrollTo(100);
    expect(screen.getByRole('status').className).not.toContain('sticky');
  });
});

describe('совет Кузьмича на карточке говорит то же, что полоса', () => {
  const advise = (r: PlaceRealtime, volcano: { colorCode: string; observedAt: string | null } | null = null) =>
    buildPlaceAdvisory({ volcano, realtime: { ...placeDayStatus(r, NOW), activeAlerts: r.activeAlerts }, hazardTypes: [] }, NOW);

  it('значение по умолчанию TRUE не даёт «спокойно»: без пересчёта — «живых данных нет»', () => {
    const a = advise(rt({ status: null, updatedAt: null }));
    expect(a.tone).toBe('unknown');
    expect(a.headline).not.toMatch(/спокойно/i);
  });

  it('закрытое — «нет», а не «можно, но с оглядкой»', () => {
    const a = advise(rt({ isOpen: false }));
    expect(a.tone).toBe('danger');
    expect(a.headline).toBe('Сегодня сюда — нет');
    expect(a.lines.join(' ')).toContain('закрыто');
  });

  it('жёлтый пересчёта — осторожность без «можно»', () => {
    const a = advise(rt({ status: 'yellow', activeAlerts: ['Паводок'] }));
    expect(a.tone).toBe('caution');
    expect(a.headline).not.toMatch(/можно/i);
    expect(a.lines.join(' ')).toContain('Паводок');
  });

  it('зональный уровень 2 под жёлтым пересчётом — не «сегодня сюда — нет» (решение 03.10)', () => {
    // Раньше совет сам считал «уровень ≥ 2 → нельзя» и спорил с пересчётом.
    expect(advise(rt({ status: 'yellow', alertSeverity: 2, activeAlerts: ['Паводок в районе'] })).tone).toBe('caution');
  });

  it('зелёный — «по сводкам спокойно» с оговоркой; слабое предупреждение — «серьёзных нет»', () => {
    const calm = advise(rt());
    expect(calm.tone).toBe('ok');
    expect(calm.headline).toBe('По сводкам спокойно');
    expect(calm.lines.join(' ')).toContain('не проверка тропы');
    const weak = advise(rt({ activeAlerts: ['Ограничение проезда'], alertSeverity: 1 }));
    expect(weak.headline).toBe('Серьёзных предупреждений нет');
    expect(weak.lines.join(' ')).toContain('В сводках: Ограничение проезда');
  });

  it('спокойный вулкан не делает спокойным место, чьи сводки не пересчитаны', () => {
    const a = advise(rt({ updatedAt: STALE }), { colorCode: 'green', observedAt: FRESH });
    expect(a.tone).toBe('unknown');
    expect(a.headline).not.toMatch(/спокойно/i);
    expect(a.lines.join(' ')).toContain('Вулкан спокоен');
  });

  it('красный пересчёта — «нет», как у полосы', () => {
    expect(advise(rt({ status: 'red', activeAlerts: ['Сход селя'] })).tone).toBe('danger');
  });
});

/**
 * Закрытие троп парка на межсезонье (слово владельца 19.11 «go», #3487).
 *
 * Карточка Авачинского перевала 17.11 писала «Сегодня там опасно»: место
 * красило закрытие маршрутов природных парков на межсезонье, а зимние туры
 * туда идут по календарю оператора. Теперь пересчёт пишет такому месту жёлтый
 * с причиной `park_season` (pg: alert-place-scope.pg.test.ts), и все
 * поверхности называют закрытие, а не опасность.
 */
describe('межсезонное закрытие троп парка (#3487)', () => {
  const CLOSURE = 'Закрытие туристических маршрутов природных парков на межсезонье';

  it('правило текста: межсезонье без названной опасности — сезонное; циклон, медведи, «до особого распоряжения» — нет', () => {
    for (const t of [
      'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья',
      'Маршруты природного парка «Ключевской» закрыты на зимний сезон',
      'Маршруты природного парка «Налычево» закрыты на межсезонье. С 1 декабря откроются зимние маршруты.',
      'В целях безопасности туристов маршруты природного парка «Налычево» закрыты на период межсезонья',
    ]) expect(isSeasonalClosure(t), t).toBe(true);
    for (const t of [
      'Из-за циклона приостановлено посещение маршрутов в природном парке «Налычево» на период межсезонья',
      'Маршруты природного парка «Налычево» закрыты на межсезонье: у тропы держатся медведи',
      'Посещение природного парка «Ключевской» приостановлено до особого распоряжения',
      'В связи с угрозой схода лавин маршруты парка «Налычево» закрыты на межсезонье',
      'Маршруты природного парка «Налычево» закрыты на период межсезонья. Опасность извержения сохраняется',
      // Сезон назван в другом предложении — не решение о сезоне.
      'Из-за ветра приостановлено посещение маршрутов в природном парке «Налычево». В межсезонье будьте осторожны.',
      'Маршруты природного парка «Налычево» закрыты до 1 октября',
      'Маршруты природного парка «Налычево» закрыты до 1 октября. В межсезонье будьте внимательны.',
    ]) expect(isSeasonalClosure(t), t).toBe(false);
  });

  // Ревью безопасности #3517: опасность словом вне прежнего списка проходила
  // за межсезонье. Теперь её ловит расширенный список, а опасность, которой в
  // списке нет вовсе, — правило причины: «из-за …» не про сезон — не сезонное.
  it('правило текста: камнепад, сели, оползень, обвал, гололёд, подтопление, «небезопасно» и любая причина, кроме сезона, — не межсезонье', () => {
    const P = 'Маршруты природного парка «Ключевской» закрыты на межсезонье';
    for (const t of [
      `${P} из-за камнепада`,
      `${P} из-за схода селей`,
      `${P} из-за оползня`,
      `${P} из-за обвала на тропе`,
      `${P} из-за гололёда`,
      `${P} из-за подтопления`,
      `${P}: на тропах небезопасно`,
      // Слова нет ни в каком списке — держит правило причины.
      `${P} из-за пурги`,
      `${P} из‑за размыва берега`,
      `${P} в связи с ремонтом моста`,
      `${P} ввиду закрытия кордона`,
      `${P}, так как река вышла из берегов`,
      // Причина с сезоном где-то дальше — всё равно не сезон.
      `${P} из-за размыва тропы в межсезонье`,
      // Опасность без слова причины — держит список.
      `${P}. На склонах камнепады`,
      `${P}. Сходят сели`,
      `${P}. Оползни на подходе`,
      `${P}. На реках подтопления`,
    ]) expect(isSeasonalClosure(t), t).toBe(false);
    for (const t of [
      'Маршруты природного парка «Налычево» закрыты в связи с межсезоньем',
      'В связи с окончанием летнего туристического сезона маршруты парка «Налычево» закрыты на межсезонье',
      'Маршруты парка «Ключевской» закрыты на зимний сезон ввиду наступления межсезонья',
    ]) expect(isSeasonalClosure(t), t).toBe(true);
  });

  it('правило дня: жёлтый с причиной — «тропы закрыты»; причина без жёлтого или при устаревшем пересчёте не читается', () => {
    expect(placeDayStatus({ isOpen: true, status: 'yellow', updatedAt: FRESH, reason: 'park_season' }, NOW))
      .toEqual({ level: 'yellow', stale: false, parkSeason: true });
    expect(placeDayStatus({ isOpen: true, status: 'red', updatedAt: FRESH, reason: 'park_season' }, NOW).parkSeason).toBeUndefined();
    expect(placeDayStatus({ isOpen: true, status: 'yellow', updatedAt: STALE, reason: 'park_season' }, NOW).parkSeason).toBeUndefined();
    expect(placeDayStatus({ isOpen: false, status: 'yellow', updatedAt: FRESH, reason: 'park_season' }, NOW).level).toBe('closed');
    expect(placeStatusFields({ isOpen: true, status: 'yellow', updatedAt: FRESH, reason: 'park_season' }, NOW).reason).toBe('park_season');
    expect(placeStatusFields({ isOpen: true, status: 'yellow', updatedAt: FRESH, reason: null }, NOW).reason).toBeNull();
    expect(placeStatusFields({ isOpen: true, status: 'red', updatedAt: FRESH, reason: 'park_season' }, NOW).reason).toBeNull();
  });

  it('полоса «Сейчас»: «Тропы парка закрыты на межсезонье», закрытие и что оно значит; не «опасно»', () => {
    const text = strip(rt({ status: 'yellow', reason: 'park_season', alertSeverity: 2, activeAlerts: [CLOSURE] }));
    expect(text).toContain(PARK_SEASON_ANSWER);
    expect(text).toContain(CLOSURE);
    expect(text).toContain(PARK_SEASON_NOTE);
    expect(text).not.toContain('Сегодня там опасно');
    expect(text).not.toContain('Есть предупреждение');
  });

  it('полоса: жёлтый без причины — общий ответ; красный с той же причиной — «опасно», без слов о межсезонье', () => {
    cleanup();
    const plain = strip(rt({ status: 'yellow', activeAlerts: [CLOSURE] }));
    expect(plain).toContain('Есть предупреждение');
    expect(plain).not.toContain(PARK_SEASON_NOTE);
    cleanup();
    const red = strip(rt({ status: 'red', reason: 'park_season', activeAlerts: [CLOSURE] }));
    expect(red).toContain('Сегодня там опасно');
    expect(red).not.toContain(PARK_SEASON_ANSWER);
    expect(red).not.toContain(PARK_SEASON_NOTE);
  });

  it('совет Кузьмича на карточке: осторожность и те же слова о закрытии', () => {
    const a = buildPlaceAdvisory({
      volcano: null,
      realtime: { ...placeDayStatus(rt({ status: 'yellow', reason: 'park_season' }), NOW), activeAlerts: [CLOSURE] },
      hazardTypes: [],
    }, NOW);
    expect(a.tone).toBe('caution');
    expect(a.headline).not.toBe('Сегодня сюда — нет');
    expect(a.lines).toContain(PARK_SEASON_NOTE);
  });

  it('место тура в ответе агенту: жёлтый с названной причиной', () => {
    const s = tourPlaceStatus({
      tp_place_id: 'p1', tp_place_name: 'Авачинский перевал', tp_place_zone: 'avachinsky',
      tp_is_open: true, tp_status: 'yellow', tp_status_at: FRESH, tp_status_reason: 'park_season',
    }, NOW);
    expect(s).toMatchObject({ level: 'yellow', reason: 'park_season' });
    expect(tourPlaceStatusLine(s!)).toContain(`ЖЁЛТЫЙ`);
    expect(tourPlaceStatusLine(s!)).toContain(PARK_SEASON_ANSWER.toLowerCase());
  });
});

/**
 * Закрытие без причины при живом межсезонном тех же парков (слово владельца
 * 19.11 «Да, вариант 2»). Строка сводки Минтура «„Налычево“ и
 * „Южно-Камчатский“, „Быстринский“ — маршруты закрыты» держала Авачинский
 * перевал красным после #3517: сезона в ней нет. Межсезонной её делает только
 * межсезонное закрытие КАЖДОГО названного парка (pg: alert-place-scope).
 */
describe('закрытие парка без причины (#3487, вариант 2)', () => {
  const MINTUR = 'Природный парк «Налычево» и «Южно-Камчатский», «Быстринский» — маршруты закрыты';
  const CITE = ' Период сводки: 09:00 12.11–09:00 19.11. Источник: https://kamgov.example/mintur/1';

  it('правило текста: голое закрытие — да; опасность, причина, «временно», «до особого распоряжения» — нет', () => {
    for (const t of [
      MINTUR,
      MINTUR + CITE,
      'Маршруты природного парка «Налычево» закрыты',
      'Посещение природного парка «Быстринский» приостановлено',
    ]) expect(isBareParkClosure(t), t).toBe(true);
    for (const t of [
      // Не закрытие парка.
      'Природный парк «Вилючинский» — маршруты открыты для посещения',
      'Дорога на Мутновский закрыта',
      // Парк не назван в предложении закрытия.
      'Туристические маршруты на Мутновский закрыты',
      // Опасность названа.
      `${MINTUR}: камнепад на тропе`,
      `${MINTUR}. На перевале метель`,
      `${MINTUR}, медведи у кордона`,
      // Причина названа — любая, даже сезон (такой текст судит isSeasonalClosure).
      `${MINTUR} из-за размыва тропы`,
      `${MINTUR} в связи с ремонтом моста`,
      `${MINTUR} в связи с межсезоньем`,
      // Признак внезапного закрытия.
      'Природный парк «Налычево» — маршруты временно закрыты',
      'Маршруты природного парка «Налычево» экстренно закрыты',
      'Маршруты природного парка «Налычево» внепланово закрыты',
      'Маршруты природного парка «Налычево» срочно закрыты',
      'Маршруты природного парка «Налычево» закрыты до особого распоряжения',
      'Маршруты природного парка «Налычево» закрыты до дальнейшего уведомления',
    ]) expect(isBareParkClosure(t), t).toBe(false);
  });

  const SEASON = 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья';
  const ALL = ['nalychevo', 'yuzhno-kamchatsky', 'bystrinskiy', 'klyuchevskoy', 'vilyuchinsky'];
  const row = (id: string, title: string, parks: string[] | null, description = '') => ({ id, title, description, affected_parks: parks });

  it('покрытие: голое закрытие межсезонное, только если каждый его парк закрыт межсезонным закрытием', () => {
    const mintur = row('m', MINTUR, ['nalychevo', 'yuzhno-kamchatsky', 'bystrinskiy'], MINTUR + CITE);
    expect(seasonalClosureIdsOf([row('s', SEASON, ALL), mintur]).sort()).toEqual(['m', 's']);
    // Межсезонного закрытия нет — голая строка остаётся красной.
    expect(seasonalClosureIdsOf([mintur])).toEqual([]);
    // Один парк не покрыт — строка красная целиком.
    expect(seasonalClosureIdsOf([row('s', 'Маршруты природного парка «Налычево» закрыты на период межсезонья', ['nalychevo', 'yuzhno-kamchatsky']), mintur]))
      .toEqual(['s']);
    // Парки не названы — покрывать нечего.
    expect(seasonalClosureIdsOf([row('s', SEASON, ALL), row('n', MINTUR, null), row('e', MINTUR, [])])).toEqual(['s']);
    // Одно голое закрытие другое не покрывает.
    expect(seasonalClosureIdsOf([row('a', MINTUR, ['nalychevo']), row('b', MINTUR, ['nalychevo'])])).toEqual([]);
    // Покрытие от закрытия с опасностью не считается.
    expect(seasonalClosureIdsOf([row('c', `${SEASON}. Из-за циклона`, ALL), mintur])).toEqual([]);
    // «Временно» — признак внезапного закрытия: покрытие не помогает.
    expect(seasonalClosureIdsOf([row('s', SEASON, ALL), row('t', 'Природный парк «Налычево» — маршруты временно закрыты', ['nalychevo'])]))
      .toEqual(['s']);
    // Обрезанный при записи текст — слово опасности могло остаться за обрезом.
    expect(seasonalClosureIdsOf([row('s', SEASON, ALL), row('x', MINTUR, ['nalychevo'], 'а'.repeat(800))])).toEqual(['s']);
  });
});
