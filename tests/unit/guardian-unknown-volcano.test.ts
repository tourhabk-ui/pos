/**
 * Вулкан без записи в справочнике мест, но со сводкой KVERT (#2134, 30.09).
 *
 * `get_guardian_context("Чикурачки")` отвечал «ни места, ни предупреждений
 * нет», хотя `get_volcano_status` знал оранжевый код KVERT этого вулкана.
 * Отсутствие данных читалось как отсутствие опасности. Теперь guardian, не
 * найдя места, спрашивает сводки вулканов и говорит, что статус МЕСТА не
 * рассчитан, а коды вулкана — вот.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGuardianContext } from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const OBSERVED = new Date(Date.now() - 3_600_000).toISOString();

function mockDb(kvert: unknown[] | Error) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM volcano_status')) {
      return kvert instanceof Error ? Promise.reject(kvert) : Promise.resolve({ rows: kvert });
    }
    if (sql.includes('MAX(observed_date)')) return Promise.resolve({ rows: [{ d: null }] });
    return Promise.resolve({ rows: [] }); // places, external_alerts, agent_knowledge — пусто
  });
}

const CHIKURACHKI = { ark: null, place_name: null, name: 'Чикурачки', acc: 'orange', ash_height_m: null, observed_at: OBSERVED };

describe('guardian: места нет, вулкан есть в сводках', () => {
  beforeEach(() => vi.clearAllMocks());

  it('отдаёт оранжевый код KVERT и говорит, что статус места не рассчитан', async () => {
    mockDb([CHIKURACHKI]);
    const out = await getGuardianContext('Чикурачки');
    expect(out).toContain('статус безопасности места не рассчитан');
    expect(out).toContain('это НЕ значит, что там безопасно');
    expect(out).toMatch(/Чикурачки: .*оранжев/i);
    expect(out).not.toMatch(/ЗЕЛЁНЫЙ/);
  });

  it('находит и по «Вулкан Чикурачки»', async () => {
    mockDb([CHIKURACHKI]);
    expect(await getGuardianContext('Вулкан Чикурачки')).toMatch(/Чикурачки: .*оранжев/i);
  });

  it('нет ни места, ни вулкана — пустой ответ, как раньше («не найдено» говорит вызывающий)', async () => {
    mockDb([CHIKURACHKI]);
    expect(await getGuardianContext('Несуществующее озеро')).toBe('');
  });

  it('вулкан из сводок и маршрут каталога с этим словом: после кодов вулкана — связка и оценка маршрута (#3302)', async () => {
    const route = {
      id: 'card-ch', db_id: 'db-ch', slug: 'voshozhdenie-na-chikurachki', title: 'Восхождение на Чикурачки',
      distance_km: '14', difficulty: 'hard', mchs_registration_required: true, mchs_phone: null, description: null,
    };
    mockQuery.mockImplementation((sql: string) => {
      // Сборщик сигналов маршрута: строка маршрута и вулканы на его коридоре.
      if (sql.includes('SELECT zone, season')) return Promise.resolve({ rows: [{ zone: null, season: null, lat: '50.32', lng: '155.46' }] });
      if (sql.includes('WITH anchor') && sql.includes('FROM volcano_status vs')) return Promise.resolve({ rows: [{ name: 'Чикурачки', acc: 'orange' }] });
      if (sql.includes('FROM kamchatka_routes kr')) return Promise.resolve({ rows: [route] });
      if (sql.includes('FROM volcano_status')) return Promise.resolve({ rows: [CHIKURACHKI] });
      if (sql.includes('MAX(observed_date)')) return Promise.resolve({ rows: [{ d: null }] });
      return Promise.resolve({ rows: [] });
    });
    const out = await getGuardianContext('Чикурачки');
    const volcano = out.indexOf('Вулкан есть в сводках вулканов:');
    const intro = out.indexOf('В каталоге Ведара есть маршрут со словами «Чикурачки» в названии — ниже его оценка на сегодня и данные из базы.');
    const block = out.indexOf('Маршрут каталога «Восхождение на Чикурачки» [ОСТОРОЖНО]');
    expect(volcano).toBeGreaterThan(-1);
    expect(intro).toBeGreaterThan(volcano);
    expect(block).toBeGreaterThan(intro);
    expect(out).toContain('Оценка маршрута на сегодня — «Осторожно»: Чикурачки: оранжевый код KVERT.');
    expect(out).toContain('Вулканы на маршруте: Чикурачки — оранжевый.');
  });

  it('сводки не прочитались — в лог, ответ без них, а не падение', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb(new Error('connection reset'));
    expect(await getGuardianContext('Чикурачки')).toBe('');
    // volcano-tool сам пишет отказ KVERT: «не смогли спросить» названо, а не проглочено.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
