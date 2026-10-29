// @vitest-environment jsdom
/**
 * «Погода в аэропорту» на /flights: загрузка сводки METAR Елизово и блок —
 * вызовом и рендером.
 *
 * Три исхода (§4.0): сводка есть — словами, с чьим наблюдением и откуда;
 * сводок нет — «нет»; сервис не ответил или ответил не сводкой — «не
 * загрузилась». Старая сводка не выдаётся за «сейчас».
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  loadAirportMetar, resetMetarCache, parseMetar, AWC_METAR_URL, type MetarRead,
} from '@/lib/flights/metar';
import { AirportWeather, METAR_ATTRIBUTION } from '@/components/flights/AirportWeather';

const NOW = new Date('2026-10-29T02:10:00Z'); // 14:10 по Камчатке
const OLDER = 'UHPP 290100Z 31004MPS 9999 BKN020 M02/M05 Q1012 NOSIG';
const NEWER = 'UHPP 290130Z 32006G11MPS 4000 -SHSN BKN012 M03/M05 Q1011 R16L/290050 NOSIG';

function textResponse(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('loadAirportMetar', () => {
  beforeEach(() => resetMetarCache());
  afterEach(() => vi.restoreAllMocks());

  it('берёт самую свежую сводку аэродрома, спрашивает своим агентом', async () => {
    const f = textResponse(`${OLDER}\n${NEWER}\n`);
    const read = await loadAirportMetar(NOW, f);
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && read.metar.observedAt).toBe('2026-10-29T01:30:00.000Z');
    expect(read.kind === 'ok' && read.stale).toBe(false);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(AWC_METAR_URL);
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/VedarBot/);
  });

  it('сводка старше полутора часов — помечена старой', async () => {
    const read = await loadAirportMetar(new Date('2026-10-29T04:00:00Z'), textResponse(NEWER));
    expect(read.kind === 'ok' && read.stale).toBe(true);
  });

  it('пустой ответ — «сводок нет», страница ошибки — отказ, HTTP 503 — отказ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadAirportMetar(NOW, textResponse(''))).kind).toBe('none');
    resetMetarCache();
    expect((await loadAirportMetar(NOW, textResponse('<html>Service Unavailable</html>'))).kind).toBe('failed');
    resetMetarCache();
    const r = await loadAirportMetar(NOW, textResponse('', 503));
    expect(r).toEqual({ kind: 'failed', reason: 'сервис сводок ответил HTTP 503' });
  });

  it('одновременные заходы ждут один запрос, а не шлют каждый свой', async () => {
    let release: (r: Response) => void = () => {};
    const f = vi.fn(() => new Promise<Response>((r) => { release = r; })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const a = loadAirportMetar(NOW, f);
    const b = loadAirportMetar(NOW, f);
    release(new Response(NEWER, { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
  });

  it('все сводки за три часа пустые (NIL) — «пустыми», а не погода', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = await loadAirportMetar(NOW, textResponse('METAR UHPP 290130Z NIL\nMETAR UHPP 290100Z NIL\n'));
    expect(read).toEqual({ kind: 'none', reason: 'сводки аэродрома за три часа пришли пустыми (NIL)' });
  });

  it('удачная сводка помнится 5 минут, отказ — минуту', async () => {
    const f = textResponse(NEWER);
    await loadAirportMetar(NOW, f);
    await loadAirportMetar(new Date(NOW.getTime() + 4 * 60_000), f);
    expect(f).toHaveBeenCalledTimes(1);
    await loadAirportMetar(new Date(NOW.getTime() + 6 * 60_000), f);
    expect(f).toHaveBeenCalledTimes(2);

    resetMetarCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await loadAirportMetar(NOW, bad);
    await loadAirportMetar(new Date(NOW.getTime() + 2 * 60_000), bad);
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe('<AirportWeather>', () => {
  afterEach(cleanup);
  const ok = (stale: boolean): MetarRead => ({ kind: 'ok', metar: parseMetar(NEWER, NOW)!, stale });

  it('сводка словами, время по Камчатке, чьё наблюдение и что не для полётов', () => {
    render(<AirportWeather read={ok(false)} />);
    expect(screen.getByText('Сводка за 13:30 по Камчатке.')).toBeTruthy();
    expect(screen.getByText('ветер северо-западный 6 м/с, порывы 11')).toBeTruthy();
    expect(screen.getByText('видимость 4000 м')).toBeTruthy();
    expect(screen.getByText('слабый ливневый снег')).toBeTruthy();
    expect(screen.getByText(METAR_ATTRIBUTION)).toBeTruthy();
    expect(METAR_ATTRIBUTION).toMatch(/Росгидромет/);
    expect(METAR_ATTRIBUTION).toMatch(/Не для планирования полётов/);
    expect(screen.getByText(NEWER)).toBeTruthy();
  });

  it('старая сводка — сказано, что старая, с датой', () => {
    render(<AirportWeather read={ok(true)} />);
    expect(screen.getByText(/Сводка за 13:30 29\.10 по Камчатке — старше 90 минут, новой нет/)).toBeTruthy();
  });

  it('не загрузилась — причина словами, погоды не выдумано', () => {
    const { container } = render(<AirportWeather read={{ kind: 'failed', reason: 'сервис сводок не ответил (timeout)' }} />);
    expect(screen.getByText(/Сводка погоды аэропорта не загрузилась: сервис сводок не ответил/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/ветер|видимость|°C/);
  });

  it('сводок нет — «нет», а не «ясно»', () => {
    render(<AirportWeather read={{ kind: 'none', reason: 'за три часа сводок аэродрома нет' }} />);
    expect(screen.getByText('За три часа сводок погоды аэродрома нет.')).toBeTruthy();
  });
});

describe('Кузьмич: погода аэропорта рядом с табло', () => {
  it('строка сводки — с чьим наблюдением и «не для полётов»; причиной задержки погода не названа', async () => {
    const { metarLine } = await import('@/lib/kuzmich/flight-tool');
    const line = metarLine({ kind: 'ok', metar: parseMetar(NEWER, NOW)!, stale: false });
    expect(line).toContain('сводка за 13:30');
    expect(line).toContain('слабый ливневый снег');
    expect(line).toMatch(/метеостанции аэропорта/);
    expect(line).toMatch(/не для планирования полётов/);
    expect(line).not.toMatch(/из-за|причин/);
    expect(metarLine({ kind: 'ok', metar: parseMetar(NEWER, NOW)!, stale: true })).toContain('старая сводка, за 13:30 29.10');
    expect(metarLine({ kind: 'failed', reason: 'сервис сводок ответил HTTP 503' })).toBe('Сводка погоды аэропорта не загрузилась: сервис сводок ответил HTTP 503.');
  });

  it('табло не прочиталось — погода всё равно сказана, «задержек нет» — нет', async () => {
    const { flightBoardText } = await import('@/lib/kuzmich/flight-tool');
    const failed = { kind: 'failed' as const, reason: 'сайт аэропорта не ответил' };
    const text = flightBoardText(
      { departures: failed, arrivals: failed, fetchedAt: NOW.toISOString() },
      {},
      { kind: 'ok', metar: parseMetar(NEWER, NOW)!, stale: false },
    );
    expect(text).toContain('Погода в аэропорту');
    expect(text).toContain('Это не значит, что задержек нет');
  });
});
