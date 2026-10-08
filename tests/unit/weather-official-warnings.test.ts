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
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

const { pool } = await import('@/lib/db-pool');
const { officialWarningLines, alertZonesForPoint } = await import('@/lib/kuzmich/weather-tool');
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
    expect(sql).toMatch(/expires_at > NOW\(\)/);
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
  it('weatherForKuzmich добавляет строки предупреждений к прогнозу', () => {
    const src = readFileSync('lib/kuzmich/weather-tool.ts', 'utf-8');
    expect(src).toMatch(/const warnings = await officialWarningLines\(point\.lat\);\s*return \[head, \.\.\.forecast\.days\.map\(forecastLine\), \.\.\.warnings\]/);
    expect(src).toMatch(/import \{ METEOALERT_PREFIX \} from '@\/lib\/services\/safety\/meteoalert'/);
  });
});
