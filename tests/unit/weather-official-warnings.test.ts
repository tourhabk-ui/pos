// @vitest-environment node
/**
 * get_weather называет действующие предупреждения Росгидромета для района
 * точки (#2289, п. 3).
 *
 * Прогноз модели и официальное предупреждение — разные вещи: модель может
 * говорить «ветер 11 км/ч», а Росгидромет в тот же день держит оранжевый по
 * ветру на побережье. Предупреждения приходят в external_alerts приёмом
 * meteoalert; ответ о погоде обязан их называть.
 *
 * Три исхода (§4.0): есть — названы; пусто — ничего не утверждается («нет
 * предупреждений» было бы без источника: приём мог молчать); не прочиталось —
 * сказано, что проверить не смогли.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner/intelligence', () => ({
  fetchForecastDays: vi.fn(async () => ({
    ok: true,
    elevationM: 20,
    days: [{ date: '2026-10-16', tempMax: 6, tempMin: 1, precipMm: 2, windKmh: 30, weatherCode: 61, description: 'дождь' }],
  })),
}));

const { pool } = await import('@/lib/db-pool');
const { officialWarningLines, alertZonesForPoint, weatherForKuzmich } = await import('@/lib/kuzmich/weather-tool');
const { KURIL_NORTH_NOTE } = await import('@/lib/safety/kuril-north');
const q = pool.query as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { q.mockReset(); });

describe('район точки — по границе приёма Росгидромета', () => {
  it('север края — от 55,5° с. ш., юг — все остальные зоны', () => {
    expect(alertZonesForPoint(56.3)).toEqual(['northern']);
    expect(alertZonesForPoint(55.5)).toEqual(['northern']);
    expect(alertZonesForPoint(53.02)).toEqual(['avachinsky', 'eastern', 'western']);
  });
});

describe('три исхода', () => {
  it('есть предупреждения — названы, с пометкой, что они важнее модели', async () => {
    q.mockResolvedValueOnce({ rows: [
      { title: 'Росгидромет: ветер — оранжевый уровень (юг края)', description: 'Ветер 25 м/с.' },
      { title: 'Росгидромет: снег — жёлтый уровень (север края)', description: null },
    ] });
    const lines = await officialWarningLines(53.02);
    expect(lines[0]).toMatch(/ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ РОСГИДРОМЕТА/);
    expect(lines[1]).toBe('- Росгидромет: ветер — оранжевый уровень (юг края). Ветер 25 м/с.');
    expect(lines[2]).toBe('- Росгидромет: снег — жёлтый уровень (север края)');
    // Только meteoalert, только действующие, только зоны точки.
    const [sql, params] = q.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/external_id LIKE \$1/);
    expect(sql).toContain(`expires_at > ${UTC_WALL_NOW_SQL}`);
    expect(sql).toMatch(/affected_zones && \$2::text\[\]/);
    expect(params).toEqual(['meteoalert/%', ['avachinsky', 'eastern', 'western']]);
  });

  it('пусто — ничего не утверждается', async () => {
    q.mockResolvedValueOnce({ rows: [] });
    expect(await officialWarningLines(53.02)).toEqual([]);
  });

  it('не прочиталось — «проверить не смог», а не тишина', async () => {
    q.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    const lines = await officialWarningLines(53.02);
    expect(lines).toEqual(['Предупреждения Росгидромета проверить не смог — не утверждай, что их нет.']);
  });
});

describe('ответ о погоде их несёт', () => {
  it('weatherForKuzmich добавляет строки предупреждений к прогнозу', async () => {
    q.mockResolvedValueOnce({ rows: [{ title: 'Росгидромет: ветер — оранжевый уровень (юг края)', description: 'Ветер 25 м/с.' }] });
    const text = await weatherForKuzmich({ lat: '53.02', lng: '158.65' });
    expect(text).toMatch(/^Прогноз Open-Meteo для «точка 53\.02, 158\.65»/);
    expect(text).toContain('16.10: +1…+6°C');
    expect(text).toContain('- Росгидромет: ветер — оранжевый уровень (юг края). Ветер 25 м/с.');
  });
});

describe('Северные Курилы — Сахалинская область (16.10)', () => {
  it('точке Парамушира камчатские предупреждения не подставляются, и это сказано словами', async () => {
    const lines = await officialWarningLines(50.68, 156.12);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(KURIL_NORTH_NOTE);
    expect(lines[0]).toMatch(/не утверждай, что предупреждений нет/);
    // В базу за камчатскими сводками не ходили вовсе.
    expect(q).not.toHaveBeenCalled();
  });

  it('ответ о погоде по координатам Северо-Курильска несёт ту же записку', async () => {
    const text = await weatherForKuzmich({ lat: '50.68', lng: '156.12' });
    expect(text).toContain(KURIL_NORTH_NOTE);
    expect(text).not.toMatch(/ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ РОСГИДРОМЕТА/);
    expect(q).not.toHaveBeenCalled();
  });

  it('мыс Лопатка — край: предупреждения спрашиваются, как у всей Камчатки', async () => {
    q.mockResolvedValueOnce({ rows: [] });
    expect(await officialWarningLines(50.877, 156.681)).toEqual([]);
    expect(q).toHaveBeenCalledTimes(1);
  });
});
