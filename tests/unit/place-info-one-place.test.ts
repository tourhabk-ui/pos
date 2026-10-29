/**
 * Сторож: `get_place_info` отвечает об ОДНОМ месте (сверка MCP 25.09).
 *
 * «Курильское озеро» вернуло озеро, кальдеру и кусок про Долину гейзеров
 * одним текстом: до трёх похожих мест шли с полными описаниями, а заметки
 * Кузьмича находились по любому упоминанию в тексте.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { composePlaceInfo, placeFactLines, placeInfoForKuzmich, PLACE_DESCRIPTION_MAX } from '@/lib/kuzmich/place-info-tool';
import { pool } from '@/lib/db-pool';
import { offerLinesForAgent, type PlaceTourOffer } from '@/lib/places/place-tours';
import { HAZARDS } from '@/lib/safety/hazard-labels';

const LAKE = { name: 'Курильское озеро', category: 'lake', district: 'Южная Камчатка', description: 'Нерестовое озеро, медведи.' };
const CALDERA = { name: 'Кальдера Курильского озера', category: 'caldera', district: null, description: 'Древняя кальдера, описание кальдеры.' };

describe('get_place_info: одно место', () => {
  it('первое место целиком, похожие — только именами и помечены отдельными', () => {
    const out = composePlaceInfo('Курильское озеро', [LAKE, CALDERA], [])!;
    // С 26.09 шапка карточки — отдельной строкой, описание — подписано.
    expect(out).toContain('Курильское озеро [lake] (Южная Камчатка)');
    expect(out).toContain('Описание: Нерестовое озеро');
    expect(out).toContain('ОТДЕЛЬНЫЕ места');
    expect(out).toContain('Кальдера Курильского озера [caldera]');
    expect(out).not.toContain('описание кальдеры');
  });

  it('чужая заметка, где место лишь упомянуто, в ответ не идёт', () => {
    const out = composePlaceInfo('Курильское озеро', [LAKE], [
      { title: 'Долина гейзеров', compiled_truth: 'Вертолёт летит мимо Курильского озера.' },
      { title: 'Курильское озеро: медведи', compiled_truth: 'Смотровые площадки только с инспектором.' },
    ])!;
    expect(out).not.toContain('Долина гейзеров');
    expect(out).toContain('Заметка Кузьмича «Курильское озеро: медведи»');
  });

  it('скрытое место не называется среди похожих, но основной ответ о нём остаётся (25.09)', () => {
    const JUNK = { name: 'Долина гейзеров. Курильское озеро. Вулканы Горелый и Авача', category: 'other', district: null, description: 'x', is_visible: false };
    const out = composePlaceInfo('Курильское озеро', [LAKE, JUNK, CALDERA], [])!;
    expect(out).not.toContain('Долина гейзеров');
    expect(out).toContain('Кальдера Курильского озера');
    const primaryHidden = composePlaceInfo('Долина гейзеров', [JUNK], [])!;
    expect(primaryHidden).toContain('Долина гейзеров. Курильское озеро');
  });

  it('ничего нет — null, и вызывающий говорит «нет в базе», а не пустоту', () => {
    expect(composePlaceInfo('Нигдейка', [], [{ title: 'Долина гейзеров', compiled_truth: 'x' }])).toBeNull();
  });
});

describe('get_place_info: факты впереди текста (внешняя проверка MCP 26.09)', () => {
  // Описание инструмента обещает «type, coordinates, hazards», а ответом был
  // один рассказ от первого лица из places.description.
  const [h1, h2] = Object.keys(HAZARDS);
  const AVACHA = {
    name: 'Вулкан Авачинский', category: 'volcano', district: null, location_type: 'volcano',
    lat: '53.25531000', lng: '158.83034000', altitude_m: 2741,
    hazard_types: [h1, h2, 'nonsense_key'], nearest_medical_km: '25.00',
    sat_communicator_required: true, registration_required: true,
    description: 'Вчера поднялся на Авачинский — домашний вулкан Петропавловска.',
  };

  it('тип, координаты, высота, опасности, медпомощь, связь, МЧС — до описания', () => {
    const out = composePlaceInfo('Авачинский', [AVACHA], [])!;
    const idx = (s: string) => out.indexOf(s);
    expect(out).toContain('Координаты: 53.25531, 158.83034');
    expect(out).toContain('Высота: 2741 м');
    expect(out).toContain(`Опасности: ${HAZARDS[h1].label.toLocaleLowerCase('ru-RU')}`);
    expect(out).toContain('До медпомощи: 25 км');
    expect(out).toContain('Спутниковая связь: нужна');
    expect(out).toContain('Регистрация группы в МЧС: требуется');
    expect(out).toMatch(/Тип: \S+/);
    expect(idx('Координаты:')).toBeGreaterThan(-1);
    expect(idx('Координаты:')).toBeLessThan(idx('Описание:'));
  });

  it('неизвестная опасность пропускается, а не звучит английским словом', () => {
    expect(placeFactLines(AVACHA).join('\n')).not.toContain('nonsense_key');
  });

  it('пустые поля — строки нет, ничего не выдумывается', () => {
    const lines = placeFactLines({ name: 'Озеро', category: null, district: null, description: null });
    expect(lines).toEqual([]);
    const out = composePlaceInfo('Озеро', [{ name: 'Озеро', category: null, district: null, description: null }], [])!;
    expect(out).toBe('Озеро');
  });

  it('длинное описание режется по концу предложения', () => {
    const long = 'Предложение. '.repeat(200);
    const out = composePlaceInfo('Место', [{ ...AVACHA, name: 'Место', description: long }], [])!;
    const desc = out.slice(out.indexOf('Описание: ') + 'Описание: '.length);
    expect(desc.length).toBeLessThanOrEqual(PLACE_DESCRIPTION_MAX + 2);
    expect(desc.endsWith('. …')).toBe(true);
  });

  it('запрос берёт профиль безопасности по ark_id (§9)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/kuzmich/place-info-tool.ts', 'utf-8');
    expect(src).toMatch(/LEFT JOIN location_safety_profile lsp ON lsp\.agent_route_id = p\.ark_id/);
  });
});

describe('скрытое место координату не называет (проверка MCP 29.09)', () => {
  // 947: «Озеро Овальное» скрыто за точку в 3 км от центра города вместо
  // подножия Авачинского. get_place_info уходит в MCP — чужой ИИ повторил бы
  // эту точку туристу.
  it('is_visible=false — ни одной цифры координаты, прямо сказано почему', async () => {
    const { placeFactLines } = await import('@/lib/kuzmich/place-info-tool');
    const lines = placeFactLines({ name: 'Озеро Овальное', description: null, category: 'lake', district: null, is_visible: false, lat: 53.0203, lng: 158.6441 });
    const text = lines.join('\n');
    expect(text).not.toMatch(/53\.02|158\.64/);
    expect(text).toMatch(/не называем — место снято с сайта/);
  });
  it('видимое место — координаты как раньше', async () => {
    const { placeFactLines } = await import('@/lib/kuzmich/place-info-tool');
    const lines = placeFactLines({ name: 'Вулкан Горелый', description: null, category: 'volcano', district: null, is_visible: true, lat: 52.58046, lng: 158.08914 });
    expect(lines.join('\n')).toMatch(/Координаты: 52\.58046, 158\.08914/);
  });
});


// ── Предложения туров к месту (слово владельца 29.10, «1в 2б 3 да») ─────

const offer = (id: string, partnerId: string, partnerName: string, extra: Partial<PlaceTourOffer> = {}): PlaceTourOffer => ({
  id, slug: `tur-${id}`, title: `Тур ${id}`, partnerId, partnerName, partnerSlug: null, partnerPublic: true,
  partnerVerified: null, basePrice: 15000, priceUnit: 'per_person', durationType: 'single_day', multiDayCount: null,
  durationHours: 10, seasonStart: null, seasonEnd: null, nearestFreeDate: null, keepsSchedule: false,
  hasDatesByRequest: true, linkKind: 'main_place', ...extra,
});

describe('get_place_info: все предложения туров к месту', () => {
  it('две компании — сводка, правило порядка и компания у каждого тура', () => {
    const lines = offerLinesForAgent('Вулкан Горелый', {
      state: 'ok', day: '2026-10-29',
      offers: [
        offer('61', 'a', 'Местечко Камчатка', { partnerVerified: true }),
        offer('72', 'b', 'Лагуна Экспедиция', { nearestFreeDate: '2027-07-26', keepsSchedule: true, hasDatesByRequest: false }),
      ],
    }, 'https://vedarai.ru');
    const text = lines.join('\n');
    expect(text).toContain('К месту «Вулкан Горелый» 2 предложения от 2 компаний');
    expect(text).toContain('Место в списке не продаётся.');
    // Компания с датой — первой: правило 1в, а не номер тура.
    expect(text.indexOf('ID72')).toBeLessThan(text.indexOf('ID61'));
    expect(text).toMatch(/ID72 «Тур 72» — Лагуна Экспедиция — 15\s000 ₽ за человека — ближайшая дата со свободными местами — 26 июля 2027 — https:\/\/vedarai\.ru\/catalog\/tours\/tur-72/);
    expect(text).toContain('ID61 «Тур 61» — Местечко Камчатка (проверен)');
    expect(text).toContain('Туры, которые проходят через несколько мест');
  });

  it('отказ чтения — «не загрузились», а не «туров нет»; пусто — «нет на витрине»', () => {
    expect(offerLinesForAgent('Вулкан Горелый', { state: 'failed' }, 'https://vedarai.ru').join('\n'))
      .toMatch(/не загрузились.*Не говори, что туров нет/);
    expect(offerLinesForAgent('Вулкан Горелый', { state: 'empty', day: '2026-10-29' }, 'https://vedarai.ru'))
      .toEqual(['К месту «Вулкан Горелый» туров на витрине нет.']);
  });

  const PLACE_ROW = { id: 'p-gorely', name: 'Вулкан Горелый', category: 'volcano', district: null, description: null, is_visible: true };
  const TOUR_ROW = (id: string, partner: string, name: string) => ({
    id, slug: `tur-${id}`, title: `Тур ${id}`, base_price: '15000', price_unit: 'per_person', duration_type: 'single_day',
    multi_day_count: null, duration_hours: '10', season_start: null, season_end: null, partner_id: partner, partner_name: name,
    partner_slug: null, partner_public: true, partner_verified: null, nearest_free_date: null, keeps_schedule: false, link_kind: 'main_place',
  });

  function db(tours: () => Promise<{ rows: unknown[] }>): void {
    vi.mocked(pool.query).mockImplementation((async (sql: string) => {
      if (/FROM route_waypoints/.test(sql)) return tours();
      if (/FROM places p/.test(sql)) return { rows: [PLACE_ROW] };
      return { rows: [] };
    }) as unknown as typeof pool.query);
  }

  it('MCP (без ссылок на страницы) тоже получает туры места с компаниями', async () => {
    db(async () => ({ rows: [TOUR_ROW('61', 'a', 'Местечко Камчатка'), TOUR_ROW('72', 'b', 'Лагуна Экспедиция')] }));
    const out = (await placeInfoForKuzmich('Горелый', { pageLinks: false }))!;
    expect(out).toContain('2 предложения от 2 компаний');
    expect(out).toContain('Местечко Камчатка');
    expect(out).toContain('Лагуна Экспедиция');
    expect(out).toContain('Место в списке не продаётся.');
  });

  it('отказ чтения туров не роняет карточку места: «не загрузились»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db(async () => { throw Object.assign(new Error('boom'), { code: '57014' }); });
    const out = (await placeInfoForKuzmich('Горелый', { pageLinks: false }))!;
    expect(out).toContain('Вулкан Горелый');
    expect(out).toContain('не загрузились');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[place-tours]'))).toBe(true);
    spy.mockRestore();
  });
});
