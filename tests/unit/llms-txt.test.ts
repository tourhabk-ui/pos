/**
 * /llms.txt — машиночитаемая правда о платформе для других ИИ.
 *
 * Повод: сторонний ассистент (Алиса) описывал нас с ошибками — выдумывал
 * навигацию и переоценивал Кузьмича («передаёт заявку оператору»). Плюс в репо
 * лежал мёртвый public/llms.txt со СТАРЫМ доменом tourhab.ru и выдуманными
 * цифрами. Тест держит served-версию честной и полной.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({
      rows: [
        { id: 'r1', title: 'Вулкан Горелый', location_type: 'volcano' },
        { id: 'r2', title: 'Паратунка', location_type: 'hot_spring' },
      ],
    }),
  },
}));

import { GET } from '@/app/llms.txt/route';

async function body(): Promise<string> {
  const res = await GET();
  return res.text();
}

describe('/llms.txt — актуально и честно', () => {
  let text = '';
  beforeEach(async () => { text = await body(); });

  it('бренд Ведар и канонический домен vedarai.ru', () => {
    expect(text).toContain('Ведар');
    expect(text).toContain('vedarai.ru');
  });

  it('НЕ содержит старый домен tourhab.ru', () => {
    expect(text).not.toMatch(/tourhab\.ru/);
  });

  it('навигация, которую сторонние ИИ раньше додумывали', () => {
    for (const path of ['/planner', '/operators', '/accommodations', '/gear', '/transfers', '/sos']) {
      expect(text, `нет ссылки ${path}`).toContain(path);
    }
  });

  it('Кузьмич описан честно: не бронирует за туриста', () => {
    expect(text).toContain('Кузьмич');
    expect(text).toMatch(/не бронирует за туриста/);
  });

  it('без выдуманных счётчиков — количество объектов из живой БД', () => {
    // Старый public/llms.txt врал «47 операторов / 120+ туров / 1000+ маршрутов».
    expect(text).not.toMatch(/1000\+ маршрут/);
    expect(text).not.toMatch(/120\+ (?:реальных )?тур/);
    // Реальное число объектов подставляется из результата запроса (тут мок = 2).
    expect(text).toContain('2+ объектах');
  });

  it('дата обновления освежена', () => {
    expect(text).toMatch(/Last-Updated:\s*2026-07/);
  });
});
