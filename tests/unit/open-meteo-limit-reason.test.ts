// @vitest-environment node
/**
 * Сторож #2289 (10.10): отказ 429 Open-Meteo называет, КАКОЙ лимит кончился.
 *
 * Повод — пост канала №479: «Налычево — снова 429, четвёртый день подряд»,
 * и к нему догадка «лимит бьёт по повторяющимся координатам». Кодом она не
 * подтверждалась (лимит Open-Meteo — на исходящий адрес, а он у прода общий),
 * а проверить было нечем: тело ответа, где сервис пишет «Minutely / Hourly /
 * Daily API request limit exceeded», выбрасывалось. Разные лимиты лечатся
 * разным, поэтому род лимита теперь в причине отказа — в логе, на /weather и
 * в ответе get_weather.
 *
 * Держится: род лимита узнаётся из тела; не-JSON и чужой текст не
 * пересказываются (голый код, как раньше); причина доходит до результата
 * fetchForecastDays.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

const { openMeteoFailureReason, fetchForecastDays } = await import('@/lib/planner/intelligence');

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const limitBody = (reason: string) => JSON.stringify({ error: true, reason });

describe('род лимита из тела 429', () => {
  it('минутный, часовой, суточный — словами', () => {
    expect(openMeteoFailureReason(429, limitBody('Minutely API request limit exceeded. Please try again in one minute.')))
      .toBe('Open-Meteo HTTP 429 (исчерпан минутный лимит запросов)');
    expect(openMeteoFailureReason(429, limitBody('Hourly API request limit exceeded. Please try again in the next hour.')))
      .toBe('Open-Meteo HTTP 429 (исчерпан часовой лимит запросов)');
    expect(openMeteoFailureReason(429, limitBody('Daily API request limit exceeded. Please try again tomorrow.')))
      .toBe('Open-Meteo HTTP 429 (исчерпан суточный лимит запросов)');
  });

  it('не JSON, нет reason, чужой текст — голый код, без пересказа', () => {
    expect(openMeteoFailureReason(429, 'rate')).toBe('Open-Meteo HTTP 429');
    expect(openMeteoFailureReason(503, '')).toBe('Open-Meteo HTTP 503');
    expect(openMeteoFailureReason(429, JSON.stringify({ error: true }))).toBe('Open-Meteo HTTP 429');
    expect(openMeteoFailureReason(400, limitBody('<script>x</script> Parameter latitude invalid'))).toBe('Open-Meteo HTTP 400');
  });
});

describe('причина доходит до результата прогноза', () => {
  it('429 с телом суточного лимита — в reason, и отказ в логе', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(limitBody('Daily API request limit exceeded. Please try again tomorrow.'), { status: 429 }),
    ));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Точка, которой нет в других тестах: кэш процесса общий на файл.
    const r = await fetchForecastDays(53.77, 159.77, 1);
    expect(r).toEqual({ ok: false, reason: 'Open-Meteo HTTP 429 (исчерпан суточный лимит запросов)' });
    expect(JSON.stringify(err.mock.calls)).toMatch(/суточный лимит/);
  });
});
