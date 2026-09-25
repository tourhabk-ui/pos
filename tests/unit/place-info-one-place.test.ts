/**
 * Сторож: `get_place_info` отвечает об ОДНОМ месте (сверка MCP 25.09).
 *
 * «Курильское озеро» вернуло озеро, кальдеру и кусок про Долину гейзеров
 * одним текстом: до трёх похожих мест шли с полными описаниями, а заметки
 * Кузьмича находились по любому упоминанию в тексте.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { composePlaceInfo } from '@/lib/kuzmich/place-info-tool';

const LAKE = { name: 'Курильское озеро', category: 'lake', district: 'Южная Камчатка', description: 'Нерестовое озеро, медведи.' };
const CALDERA = { name: 'Кальдера Курильского озера', category: 'caldera', district: null, description: 'Древняя кальдера, описание кальдеры.' };

describe('get_place_info: одно место', () => {
  it('первое место целиком, похожие — только именами и помечены отдельными', () => {
    const out = composePlaceInfo('Курильское озеро', [LAKE, CALDERA], [])!;
    expect(out).toContain('Курильское озеро [lake] (Южная Камчатка): Нерестовое озеро');
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

  it('ничего нет — null, и вызывающий говорит «нет в базе», а не пустоту', () => {
    expect(composePlaceInfo('Нигдейка', [], [{ title: 'Долина гейзеров', compiled_truth: 'x' }])).toBeNull();
  });
});
