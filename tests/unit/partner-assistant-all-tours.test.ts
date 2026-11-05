// @vitest-environment node
/**
 * Помощник партнёра видит все свои туры и не обещает файлов (05.11).
 *
 * Гид Андрей Запорожец попросил в MAX «дай мне текст тура в формате word».
 * Модель пообещала .docx (выгрузки файлов на платформе нет), а на название
 * «Вачкажец + озёрки» ответила «такого тура у вас нет»: в контекст шли первые
 * 10 туров, у гида их 13 с одинаковым created_at, и нужный был отрезан.
 *
 * Сторож держит: 13 туров — все 13 в контексте; если предел всё же срезал,
 * сказано «показаны N из M»; инструмент своих туров говорит то же; промпт
 * запрещает обещать файлы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => new Map(),
  fetchAvailabilityForTour: vi.fn().mockResolvedValue([]),
}));

import { buildOperatorContext, partnerSystemPrompt, CONTEXT_TOURS_MAX } from '@/lib/kuzmich/operator-chat';
import { runMyToursSchedule } from '@/lib/kuzmich/operator-tours-tool';

const TITLES = [
  'Ганальские Востряки', 'Авачинский перевал, Верблюд', 'Толмачёво + купание', 'Вачкажец + озёрки',
  'Горелый', 'Мутновский', 'Вилючик', 'Козельский', 'Авачинский', 'Камень Верблюд',
  'Халактырский пляж', 'Налычево', 'Паратунка',
];

function tourRows(n: number, total: number) {
  return TITLES.slice(0, n).map((title, i) => ({
    id: i + 1, title, base_price: 15000, is_active: i < 5, is_published: i < 5, available_slots: null,
    total_count: String(total),
  }));
}

/** База для buildOperatorContext: туры, брони за неделю, предстоящие. */
function fakeDb(rows: ReturnType<typeof tourRows>) {
  const calls: string[] = [];
  return {
    calls,
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (/FROM operator_tours\s+WHERE operator_id/.test(sql)) return { rows };
      if (/AS awaiting/.test(sql)) return { rows: [{ cnt: '0', awaiting: '0' }] };
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('контекст помощника: свои туры', () => {
  it('13 туров — все 13 в контексте, без «показаны N из M»', async () => {
    const db = fakeDb(tourRows(13, 13));
    const text = await buildOperatorContext('p-1', db as never);
    for (const t of TITLES) expect(text).toContain(`"${t}"`);
    expect(text).not.toMatch(/Показаны \d+ из/);
    const tourSql = db.calls.find((s) => /FROM operator_tours\s+WHERE operator_id/.test(s))!;
    expect(tourSql).toMatch(new RegExp(`LIMIT ${CONTEXT_TOURS_MAX}\\b`));
    expect(CONTEXT_TOURS_MAX).toBeGreaterThanOrEqual(13);
  });

  it('предел срезал — сказано, сколько всего, и что «нет» утверждать нельзя', async () => {
    const text = await buildOperatorContext('p-1', fakeDb(tourRows(13, 60)) as never);
    expect(text).toMatch(/Показаны 13 из 60/);
    expect(text).toMatch(/не утверждай, что тура нет/);
  });
});

describe('инструмент «мои туры»: отсечка названа', () => {
  it('13 туров гида — все 13 в ответе инструмента', async () => {
    poolQuery.mockResolvedValue({ rows: tourRows(13, 13).map(({ id, title, is_active, is_published, total_count }) => ({
      id, title, is_active, is_published, max_participants: 4, season_start: null, season_end: null, total_count,
    })) });
    const out = await runMyToursSchedule('11111111-1111-1111-1111-111111111111', {}, Date.parse('2026-11-05T00:00:00Z'));
    for (const t of TITLES) expect(out).toContain(`«${t}»`);
    const sql = String(poolQuery.mock.calls[0][0]);
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
    expect(limit).toBeGreaterThanOrEqual(13);
  });

  it('подошло больше, чем показано, — «показаны N из M»', async () => {
    poolQuery.mockResolvedValue({ rows: tourRows(10, 13).map(({ id, title, is_active, is_published, total_count }) => ({
      id, title, is_active, is_published, max_participants: 6, season_start: null, season_end: null, total_count,
    })) });
    const out = await runMyToursSchedule('11111111-1111-1111-1111-111111111111', {}, Date.parse('2026-11-05T00:00:00Z'));
    expect(out).toMatch(/Показаны 10 из 13/);
  });

  it('все поместились — без оговорки', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: 4, title: 'Вачкажец + озёрки', is_active: false, is_published: false,
      max_participants: 6, season_start: null, season_end: null, total_count: '1' }] });
    const out = await runMyToursSchedule('11111111-1111-1111-1111-111111111111', { tour: 'Вачкажец' }, Date.parse('2026-11-05T00:00:00Z'));
    expect(out).toContain('Вачкажец + озёрки');
    expect(out).not.toMatch(/Показаны \d+ из/);
  });
});

describe('промпт: файлов помощник не обещает', () => {
  for (const category of ['guide', 'operator', 'transfer']) {
    it(category, () => {
      const prompt = partnerSystemPrompt(
        { partnerId: 'p-1', partnerName: 'Партнёр', category, crmCategory: 'guide', userId: 'u-1', sellsTours: true } as never,
        Date.parse('2026-11-05T00:00:00Z'), true,
      );
      expect(prompt).toMatch(/Файлов \(Word, \.docx, PDF, таблиц\) ты не готовишь и не присылаешь и не обещаешь их/);
      // Текст тура модель не сочиняет: его нет в её данных (05.11).
      expect(prompt).toMatch(/Текстов туров \(описание, анонс, программа, что включено, что взять\) в твоих данных НЕТ/);
      expect(prompt).toMatch(/Никогда не пиши их от себя/);
    });
  }
});
