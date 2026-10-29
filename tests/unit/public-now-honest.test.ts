/**
 * «Сейчас на Камчатке» (/api/public/now) не обещает того, чего нет (29.10).
 *
 * Разбор бесплатных API нашёл в ответе два вранья: «северное сияние» как
 * примету ноября и декабря (на Камчатке его видно лишь в сильную магнитную
 * бурю, редко и в любой месяц) и лестницу кодов погоды, где сплошная
 * облачность (WMO 3) называлась «ясно». Третье — отказ погоды глушился
 * пустым catch. Проверяется вызовом роута.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const swallowed = vi.fn();
vi.mock('@/lib/observability/swallowed', () => ({
  logSwallowedFailure: (...a: unknown[]) => swallowed(...a),
}));

function weather(code: number, temperature = 4) {
  return new Response(JSON.stringify({ current_weather: { temperature, weathercode: code } }), { status: 200 });
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('в ноябре и декабре сияние сезоном не называется', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => weather(0));
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementationOnce(async () => weather(3));
    expect((await callNow()).data.weatherDesc).toBe('пасмурно');
    fetchSpy.mockImplementationOnce(async () => weather(45));
    expect((await callNow()).data.weatherDesc).toBe('туман');
    fetchSpy.mockImplementationOnce(async () => weather(0, -2));
    const clear = (await callNow()).data;
    expect(clear.weatherDesc).toBe('ясно');
    expect(clear.temperature).toBe(-2);
  });

  it('незнакомый код — описания нет, а не догадка', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => weather(42));
    expect((await callNow()).data.weatherDesc).toBeNull();
  });

  it('погода не пришла — поля пустые, причина в логе', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    const { data } = await callNow();
    expect(data.temperature).toBeNull();
    expect(data.weatherDesc).toBeNull();
    expect(swallowed).toHaveBeenCalledWith('public-now', 'погода', expect.any(Error));
  });

  it('Open-Meteo ответил ошибкой — тоже в лог, не молча', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quota', { status: 429 }));
    const { data } = await callNow();
    expect(data.weatherDesc).toBeNull();
    expect(swallowed).toHaveBeenCalledWith('public-now', 'погода', expect.objectContaining({ message: 'Open-Meteo HTTP 429' }));
  });
});
