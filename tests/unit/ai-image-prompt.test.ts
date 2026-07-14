/**
 * Промпт AI-генератора картинок: вулкан — спокойный конус, БЕЗ фейкового
 * извержения (иначе потухшие сопки получают кадр извержения — см. миграцию 746).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { buildImagePrompt } from '@/lib/services/ai-image-generator';

describe('buildImagePrompt', () => {
  it('вулкан — заснеженный конус, без "eruption"/"pyroclastic"', () => {
    const p = buildImagePrompt('Авачинская сопка', 'volcano', 'Действующий вулкан у Петропавловска-Камчатского.');
    const lower = p.toLowerCase();
    expect(lower).not.toContain('eruption');
    expect(lower).not.toContain('pyroclastic');
    expect(lower).toContain('stratovolcano');
    expect(p).toContain('Авачинская сопка');
  });

  it('неизвестный тип → other-промпт про Камчатку', () => {
    const p = buildImagePrompt('Нечто', null, '');
    expect(p).toContain('Kamchatka');
  });

  it('описание попадает в промпт первым предложением', () => {
    const p = buildImagePrompt('Озеро X', 'lake', 'Кристально чистое озеро. Второе предложение.');
    expect(p).toContain('Кристально чистое озеро');
    expect(p).not.toContain('Второе предложение');
  });
});
