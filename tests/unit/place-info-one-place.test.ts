/**
 * Сторож: `get_place_info` отвечает об ОДНОМ месте (сверка MCP 25.09).
 *
 * «Курильское озеро» вернуло озеро, кальдеру и кусок про Долину гейзеров
 * одним текстом: до трёх похожих мест шли с полными описаниями, а заметки
 * Кузьмича находились по любому упоминанию в тексте.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { composePlaceInfo, placeFactLines, PLACE_DESCRIPTION_MAX } from '@/lib/kuzmich/place-info-tool';
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

