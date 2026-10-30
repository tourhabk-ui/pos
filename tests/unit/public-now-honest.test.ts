/**
 * «Сейчас на Камчатке» (/api/public/now) не обещает того, чего нет (29.10).
 *
 * Разбор бесплатных API нашёл в ответе два вранья: «северное сияние» как
 * примету ноября и декабря (на Камчатке его видно лишь в сильную магнитную
 * бурю, редко и в любой месяц) и лестницу кодов погоды, где сплошная
 * облачность (WMO 3) называлась «ясно». Третье — отказ погоды глушился
 * пустым catch. Проверяется вызовом роута.
 *
 * С 29.10 (#2289) погода роута — общий прогноз `fetchForecastDays` (своего
 * запроса к Open-Meteo нет); здесь он подменён, а то, что роут идёт именно
 * через него, держит open-meteo-one-path.test.ts вызовом с настоящим модулем.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const swallowed = vi.fn();
vi.mock('@/lib/observability/swallowed', () => ({
  logSwallowedFailure: (...a: unknown[]) => swallowed(...a),
}));

const { fetchForecastDays } = vi.hoisted(() => ({ fetchForecastDays: vi.fn() }));
vi.mock('@/lib/planner/intelligence', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/intelligence')>()),
  fetchForecastDays,
}));

function weather(code: number, temperature = 4) {
  return {
    ok: true as const,
    days: [],
    hours: [],
    now: { time: '2026-10-29T13:00', temp: temperature, apparent: null, humidity: null, weatherCode: code, description: null,
      windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: true },
  };
}

async function callNow() {
  const { GET } = await import('@/app/api/public/now/route');
  const res = await GET();
  return (await res.json()) as { data: { temperature: number | null; weatherDesc: string | null; seasonNote: string } };
}

describe('/api/public/now', () => {
  beforeEach(() => {
    poolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    swallowed.mockReset();
    fetchForecastDays.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('в ноябре и декабре сияние сезоном не называется', async () => {
    fetchForecastDays.mockImplementation(async () => weather(0));
    for (const date of ['2026-11-15T03:00:00Z', '2026-12-15T03:00:00Z']) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(date));
      const { data } = await callNow();
      expect(data.seasonNote).not.toMatch(/сияни/i);
      expect(data.seasonNote.length).toBeGreaterThan(0);
      vi.useRealTimers();
    }
  });

  it('сплошная облачность — «пасмурно», туман — «туман», а не «ясно» и «облачно»', async () => {
    fetchForecastDays.mockImplementationOnce(async () => weather(3));
    expect((await callNow()).data.weatherDesc).toBe('пасмурно');
    fetchForecastDays.mockImplementationOnce(async () => weather(45));
    expect((await callNow()).data.weatherDesc).toBe('туман');
    fetchForecastDays.mockImplementationOnce(async () => weather(0, -2));
    const clear = (await callNow()).data;
    expect(clear.weatherDesc).toBe('ясно');
    expect(clear.temperature).toBe(-2);
  });

  it('незнакомый код — описания нет, а не догадка', async () => {
    fetchForecastDays.mockImplementation(async () => weather(42));
    expect((await callNow()).data.weatherDesc).toBeNull();
  });

  it('погода не пришла — поля пустые, причина в логе', async () => {
    fetchForecastDays.mockRejectedValue(new Error('timeout'));
    const { data } = await callNow();
    expect(data.temperature).toBeNull();
    expect(data.weatherDesc).toBeNull();
    expect(swallowed).toHaveBeenCalledWith('public-now', 'погода', expect.any(Error));
  });

  it('общий прогноз не получен — тоже в лог, не молча', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'источник прогноза ответил ошибкой (HTTP 429)' });
    const { data } = await callNow();
    expect(data.weatherDesc).toBeNull();
    expect(data.temperature).toBeNull();
    expect(swallowed).toHaveBeenCalledWith('public-now', 'погода', expect.objectContaining({ message: 'источник прогноза ответил ошибкой (HTTP 429)' }));
  });

  it('блока current нет — «сейчас» берётся из текущего часа прогноза, а запасной прогноз помечен', async () => {
    fetchForecastDays.mockResolvedValue({
      ok: true, days: [], now: null, staleSince: '2026-10-29T00:00:00.000Z',
      hours: [
        { time: '2000-01-01T00:00', temp: 99, weatherCode: 0 },
        { time: '2999-01-01T00:00', temp: 3.4, weatherCode: 3 },
      ],
    });
    const { data } = await callNow() as { data: { temperature: number | null; weatherDesc: string | null; weatherStaleSince?: string | null } };
    expect(data.temperature).toBe(3.4);
    expect(data.weatherDesc).toBe('пасмурно');
    expect(data.weatherStaleSince).toBe('2026-10-29T00:00:00.000Z');
  });
});
