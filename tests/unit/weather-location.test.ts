/**
 * Сторож находки аудита 08.09: погода МЕСТА, а не города по умолчанию.
 *
 * SDK-инструмент `get_weather` объявлял аргумент `location` и звал в пример
 * «Мутновский», а его `execute` не принимал аргументов ВОВСЕ и читал
 * `weather_cache` с жёстким `location = 'petropavlovsk'`. Турист спрашивал
 * про перевал, получал город — и узнать об этом из ответа не мог: имени
 * места в нём не было.
 *
 * Проверяется здесь не прогноз (он из сети), а три свойства формы ответа:
 * аргумент читается, место названо, отказ назван отказом.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('lib/agents/sdk/tourist-tools.ts', 'utf8');

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner/intelligence', () => ({ fetchWeatherForecast: vi.fn() }));
vi.mock('@/lib/planner/compose', () => ({ composeTrip: vi.fn() }));

const { pool } = await import('@/lib/db-pool');
const { fetchWeatherForecast } = await import('@/lib/planner/intelligence');
const { getTouristTools } = await import('@/lib/agents/sdk/tourist-tools');

function weatherTool() {
  const t = getTouristTools(null).find((x) => x.name === 'get_weather');
  if (!t) throw new Error('инструмент get_weather не найден');
  return t;
}

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const forecast = fetchWeatherForecast as unknown as ReturnType<typeof vi.fn>;

const DAY = {
  date: '2026-09-08', tempMax: 9, tempMin: 2, precipMm: 0,
  windKmh: 14, weatherCode: 1, description: 'Ясно',
};

describe('погода: аргумент места действительно читается', () => {
  it('таблицы weather_cache в исходнике больше нет', () => {
    // Её не заводила ни одна миграция и не писала ни одна строка кода:
    // читать было нечего в принципе, а ответ выглядел как погода.
    // Запрещается ОБРАЩЕНИЕ к таблице, а не слово: разбор выше её называет.
    expect(SRC).not.toMatch(/FROM\s+weather_cache/i);
    // И сам аргумент теперь читается: прежний execute не принимал ничего.
    expect(SRC).toMatch(/execute:\s*async \(args\)[\s\S]{0,200}args\.location/);
  });

  it('второго источника прогноза не заведено — берётся единственный', () => {
    expect(SRC).toContain("from '@/lib/planner/intelligence'");
    expect(SRC).not.toMatch(/fetch\(\s*['"`]https:\/\/api\.open-meteo/);
  });

  it('координаты берутся у запрошенного места, а не у города по умолчанию', async () => {
    vi.clearAllMocks();
    q.mockResolvedValueOnce({ rows: [{ name: 'Мутновский', lat: 52.45, lng: 158.2 }] });
    forecast.mockResolvedValueOnce([DAY]);

    const out = JSON.parse(await weatherTool().execute({ location: 'Мутновский' }));

    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][1]).toEqual(['%Мутновский%']);
    expect(forecast).toHaveBeenCalledWith(52.45, 158.2, 3);
    expect(out.location).toBe('Мутновский');
    expect(out.status).toBe('ок');
  });

  it('живость места учтена: скрытые и слитые точки местом не считаются', () => {
    expect(SRC).toMatch(/is_visible = true AND merged_into_id IS NULL/);
  });

  it('место названо в ответе всегда — подмену видно', async () => {
    vi.clearAllMocks();
    forecast.mockResolvedValueOnce([DAY]);
    const out = JSON.parse(await weatherTool().execute({}));
    expect(out.location).toBe('Петропавловск-Камчатский');
    expect(q).not.toHaveBeenCalled();
  });
});

describe('погода: третий исход назван вслух', () => {
  it('места нет в справочнике — так и сказано, чужая погода не подставляется', async () => {
    vi.clearAllMocks();
    q.mockResolvedValueOnce({ rows: [] });
    const out = JSON.parse(await weatherTool().execute({ location: 'Гора Которой Нет' }));
    expect(out.status).toBe('место_не_найдено');
    expect(out.location_requested).toBe('Гора Которой Нет');
    expect(forecast).not.toHaveBeenCalled();
  });

  it('прогноз не пришёл — «не смог», а не «погода хорошая»', async () => {
    vi.clearAllMocks();
    forecast.mockResolvedValueOnce([]);
    const out = JSON.parse(await weatherTool().execute({}));
    expect(out.status).toBe('не_смог');
    expect(out.days).toBeUndefined();
  });

  it('отказ базы пишется в лог поимённо, а не глотается', async () => {
    vi.clearAllMocks();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('нет связи'), { code: '08006' });
    q.mockRejectedValueOnce(err);

    const out = JSON.parse(await weatherTool().execute({ location: 'Мутновский' }));

    expect(out.status).toBe('не_смог');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[tourist-tools]'),
      expect.objectContaining({ code: '08006' }),
    );
    spy.mockRestore();
  });
});
