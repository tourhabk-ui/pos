/**
 * Кнопка «Обновить данные» на экране безопасности правда опрашивает
 * источники (владелец 26.09: «очень быстро обновляет, вряд ли за это время
 * он обходит сайты»).
 *
 * До этого кнопка перечитывала нашу базу, к источнику шла только погода, а
 * подпись говорила «Спрашиваем источники...» и «Проверено только что» — по
 * времени погоды. Сторож держит связку целиком: правило «когда можно», роут,
 * который зовёт ТОТ ЖЕ сбор, что супервизор, общий потолок на инстанс,
 * реестр публичных роутов и экран, который зовёт роут и не подмешивает
 * погоду во время опроса.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  MANUAL_REFRESH_WAIT_MS,
  MANUAL_REFRESH_FOLLOWUP_MS,
  MANUAL_REFRESH_FOLLOWUP_TRIES,
  SCREEN_STALE_MS,
  manualRefreshDecision,
  manualRefreshNote,
  ingestFinishedSince,
  screenIsStale,
  type ManualRefreshOutcome,
} from '@/lib/safety/manual-refresh';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/safety/refresh/route.ts'), 'utf-8');
const CLIENT = readFileSync(join(ROOT, 'app/safety/_SafetyClient.tsx'), 'utf-8');

describe('правило: когда кнопка вправе опросить источники', () => {
  const now = 1_000_000_000;
  it('сбор меньше двух минут назад не повторяется', () => {
    expect(manualRefreshDecision(now - 30_000, now)).toBe('recent');
    expect(manualRefreshDecision(now - MANUAL_REFRESH_MIN_INTERVAL_MS + 1, now)).toBe('recent');
  });
  it('старше двух минут — идём к источникам', () => {
    expect(manualRefreshDecision(now - MANUAL_REFRESH_MIN_INTERVAL_MS, now)).toBe('run');
    expect(manualRefreshDecision(now - 5 * 60_000, now)).toBe('run');
  });
  it('не знаем, когда был сбор, — не запрещаем (потолок держит ограничитель)', () => {
    expect(manualRefreshDecision(null, now)).toBe('run');
  });
  it('у каждого исхода, кроме «опросили», своя строка, и ни одна не говорит «проверено»', () => {
    const outcomes: ManualRefreshOutcome[] = ['partial', 'recent', 'timeout', 'failed'];
    for (const o of outcomes) {
      const note = manualRefreshNote(o);
      expect(note, o).toBeTruthy();
      expect(note, o).not.toMatch(/проверено/i);
    }
    expect(manualRefreshNote('ran')).toBeNull();
  });
});

describe('роут: тот же сбор, что у супервизора, и общий потолок', () => {
  it('зовёт GET /api/cron/safety-ingest, а не свою копию обхода', () => {
    expect(ROUTE).toMatch(/import \{ GET as runIngest \} from '@\/app\/api\/cron\/safety-ingest\/route'/);
    expect(ROUTE).not.toMatch(/fetchTelegramPreview|ingestAll|fetchEmsdPage/);
  });
  it('потолок общий на инстанс, а не на человека', () => {
    expect(ROUTE).toMatch(/allowFresh\('safety-ingest-button', MANUAL_REFRESH_MIN_INTERVAL_MS/);
  });
  it('роут публичен только на POST', () => {
    expect(isPublicApiPath('/api/safety/refresh', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/safety/refresh', 'GET')).toBe(false);
  });
  it('секрет крона в ответ не попадает', () => {
    const reply = ROUTE.slice(ROUTE.indexOf('function reply'), ROUTE.indexOf('export async function POST'));
    expect(reply).toMatch(/\{ outcome, checked_at: checkedAt, note: manualRefreshNote\(outcome\) \}/);
    expect(reply).not.toMatch(/secret/i);
  });
});

describe('роут: поведение', () => {
  const runIngest = vi.fn();
  const lastIngestAt = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    runIngest.mockReset();
    lastIngestAt.mockReset();
    vi.doMock('@/app/api/cron/safety-ingest/route', () => ({ GET: runIngest }));
    vi.doMock('@/lib/safety/ingest-run', () => ({ lastIngestAt }));
    process.env.CRON_SECRET = 'test-secret';
    const throttle = await import('@/lib/safety/refresh-throttle');
    throttle.resetThrottle();
  });

  const okBody = (sources: Record<string, unknown>) =>
    new Response(JSON.stringify({ success: true, sources }), { status: 200 });

  it('сбор был 30 с назад — источники не трогаем', async () => {
    lastIngestAt.mockResolvedValue(new Date(Date.now() - 30_000).toISOString());
    const { POST } = await import('@/app/api/safety/refresh/route');
    const body = await (await POST()).json();
    expect(body.outcome).toBe('recent');
    expect(runIngest).not.toHaveBeenCalled();
  });

  it('сбор был 5 мин назад — запускаем сбор с секретом из процесса', async () => {
    lastIngestAt.mockResolvedValue(new Date(Date.now() - 5 * 60_000).toISOString());
    runIngest.mockResolvedValue(okBody({ mchs: { fetched: true, errors: [] } }));
    const { POST } = await import('@/app/api/safety/refresh/route');
    const body = await (await POST()).json();
    expect(body.outcome).toBe('ran');
    expect(runIngest).toHaveBeenCalledTimes(1);
    const req = runIngest.mock.calls[0][0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer test-secret');
  });

  it('два нажатия одновременно — один сбор', async () => {
    lastIngestAt.mockResolvedValue(null);
    let release: (r: Response) => void = () => {};
    runIngest.mockReturnValue(new Promise<Response>((r) => { release = r; }));
    const { POST } = await import('@/app/api/safety/refresh/route');
    const a = POST();
    const b = POST();
    await new Promise((r) => setTimeout(r, 0));
    release(okBody({}));
    const [ra, rb] = await Promise.all([a, b]);
    expect(runIngest).toHaveBeenCalledTimes(1);
    expect((await ra.json()).outcome).toBe('ran');
    expect((await rb.json()).outcome).toBe('ran');
  });

  it('источник с ошибкой — «частично», а не «опросили»', async () => {
    lastIngestAt.mockResolvedValue(null);
    runIngest.mockResolvedValue(okBody({
      mchs: { fetched: true, errors: ['HTTP 503'] },
      usgs: { fetched: true, errors: [] },
    }));
    const { POST } = await import('@/app/api/safety/refresh/route');
    expect((await (await POST()).json()).outcome).toBe('partial');
  });

  it('сбор ответил не 200 — «не удалось», время не выдумывается', async () => {
    lastIngestAt.mockResolvedValue(null);
    runIngest.mockResolvedValue(new Response('{}', { status: 500 }));
    const { POST } = await import('@/app/api/safety/refresh/route');
    const body = await (await POST()).json();
    expect(body.outcome).toBe('failed');
    expect(body.checked_at).toBeNull();
  });
});

describe('экран: кнопка зовёт сбор и не подмешивает погоду', () => {
  it('нажатие идёт в /api/safety/refresh POST до перечитывания экрана', () => {
    const handler = CLIENT.slice(CLIENT.indexOf('const handleRefresh'), CLIENT.indexOf('}, [reloadScreen, followIngest, refreshState]'));
    expect(handler).toMatch(/fetch\('\/api\/safety\/refresh', \{ method: 'POST' \}\)/);
    expect(handler.indexOf("'/api/safety/refresh'")).toBeLessThan(handler.indexOf('reloadScreen(true)'));
  });
  it('время погоды не становится временем опроса источников', () => {
    const weather = CLIENT.slice(CLIENT.indexOf('/api/safety/weather?fresh='), CLIENT.indexOf('/api/safety/weather?fresh=') + 400);
    expect(weather).not.toMatch(/setCheckedAt/);
  });
  it('подпись говорит «источники опрошены», а не «проверено»', () => {
    expect(CLIENT).toMatch(/Источники опрошены \$\{fmtAgo/);
    expect(CLIENT).not.toMatch(/`Проверено \$\{fmtAgo/);
  });
});

/**
 * Кнопка перечитывает ВЕСЬ экран, а не его нижнюю половину (01.10).
 *
 * Радар, лента предупреждений и пульсы приходят пропом `live` — серверным
 * рендером страницы. Кнопка звала один loadAll, который этот блок не трогает,
 * и верхний блок оставался таким, каким страница открылась. Владелец:
 * «хоть я и нажимал на радаре обновить данные» — толчка на радаре не было.
 */
describe('экран: кнопка перечитывает и радар', () => {
  const bodyOf = (start: string, end: string) => {
    const at = CLIENT.indexOf(start);
    expect(at, `${start} не найден`).toBeGreaterThan(0);
    return CLIENT.slice(at, CLIENT.indexOf(end, at));
  };

  it('радар и пульсы рисуются из серверного пропа live — значит перечитывать их может только сервер', () => {
    expect(CLIENT).toMatch(/<RadarScope hazards=\{live\.radar\.hazards\}/);
    expect(CLIENT).toMatch(/<SeismicPulse events=\{live\.seismic\.events\}/);
  });

  it('перечитывание экрана зовёт router.refresh() и loadAll', () => {
    const reload = bodyOf('const reloadScreen = useCallback', '}, [router, loadAll]);');
    expect(reload).toMatch(/router\.refresh\(\)/);
    expect(reload).toMatch(/return loadAll\(fresh\)/);
    expect(CLIENT).toMatch(/import \{ useRouter \} from 'next\/navigation'/);
  });

  it('кнопка перечитывает экран через reloadScreen, а не голым loadAll', () => {
    const handler = bodyOf('const handleRefresh', '}, [reloadScreen, followIngest, refreshState]');
    expect(handler).toMatch(/await reloadScreen\(true\)/);
    expect(handler).not.toMatch(/await loadAll\(true\)/);
  });
});

/**
 * «Источники отвечают долго — данные обновятся сами»: у обещания есть
 * производитель (01.10). До этого экран перечитывался один раз, ДО того как
 * продолжавшийся сбор что-то записал, и больше никто его не перечитывал.
 */
describe('экран: «обновятся сами» обеспечено дожиданием сбора', () => {
  const follow = CLIENT.slice(
    CLIENT.indexOf('const followIngest = useCallback'),
    CLIENT.indexOf('}, [reloadScreen]);', CLIENT.indexOf('const followIngest = useCallback')),
  );

  it('исход «долго» запускает дожидание с временем сбора до нажатия', () => {
    expect(CLIENT).toMatch(/before = d\.checked_at \?\? null/);
    expect(CLIENT).toMatch(/if \(outcome === 'timeout'\) void followIngest\(before\)/);
  });

  it('дожидание спрашивает время последнего сбора и перечитывает экран, когда оно сдвинулось', () => {
    expect(follow).toMatch(/fetch\('\/api\/safety\/seismic\?fresh=0'\)/);
    expect(follow).toMatch(/ingestFinishedSince\(before, checked\)/);
    expect(follow).toMatch(/await reloadScreen\(false\)/);
  });

  it('попыток конечное число, по исчерпании — честная строка', () => {
    expect(follow).toMatch(/for \(let i = 0; i < MANUAL_REFRESH_FOLLOWUP_TRIES; i\+\+\)/);
    expect(follow).toMatch(/setRefreshNote\(MANUAL_REFRESH_GAVE_UP_NOTE\)/);
    // Две минуты дожидания поверх минуты ожидания кнопки — но не вечность.
    const total = MANUAL_REFRESH_WAIT_MS + MANUAL_REFRESH_FOLLOWUP_MS * MANUAL_REFRESH_FOLLOWUP_TRIES;
    expect(total).toBeGreaterThanOrEqual(2 * 60_000);
    expect(total).toBeLessThanOrEqual(5 * 60_000);
  });

  it('уход со страницы и новое нажатие обрывают прежнее дожидание', () => {
    expect(CLIENT).toMatch(/useEffect\(\(\) => \(\) => \{\s*followUpGen\.current\+\+;\s*if \(followUpTimer\.current\) clearTimeout\(followUpTimer\.current\);/);
    const handler = CLIENT.slice(CLIENT.indexOf('const handleRefresh'), CLIENT.indexOf("fetch('/api/safety/refresh'"));
    expect(handler).toMatch(/followUpGen\.current\+\+/);
  });
});

describe('экран: возврат на давно открытую вкладку перечитывает её', () => {
  it('по visibilitychange, только если экран устарел и сеть есть', () => {
    const at = CLIENT.indexOf("addEventListener('visibilitychange'");
    expect(at).toBeGreaterThan(0);
    const block = CLIENT.slice(CLIENT.lastIndexOf('useEffect(() => {', at), at);
    expect(block).toMatch(/screenIsStale\(lastScreenLoad\.current, Date\.now\(\)\)/);
    expect(block).toMatch(/navigator\.onLine === false\) return/);
    expect(block).toMatch(/void reloadScreen\(false\)/);
  });
});

describe('правила дожидания и устаревания', () => {
  it('сбор закончился — время последнего сбора ушло дальше того, что было до нажатия', () => {
    expect(ingestFinishedSince('2026-10-01T00:00:00Z', '2026-10-01T00:01:30Z')).toBe(true);
  });
  it('время то же или раньше — ещё идёт', () => {
    expect(ingestFinishedSince('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')).toBe(false);
    expect(ingestFinishedSince('2026-10-01T00:00:00Z', '2026-09-30T23:59:00Z')).toBe(false);
  });
  it('времени сбора нет или оно нечитаемо — «не знаем», не «закончился»', () => {
    expect(ingestFinishedSince('2026-10-01T00:00:00Z', null)).toBe(false);
    expect(ingestFinishedSince('2026-10-01T00:00:00Z', 'не дата')).toBe(false);
  });
  it('времени до нажатия не знали — любой прочитанный сбор считается', () => {
    expect(ingestFinishedSince(null, '2026-10-01T00:01:30Z')).toBe(true);
  });
  it('экран устаревает через пять минут', () => {
    expect(SCREEN_STALE_MS).toBe(5 * 60_000);
    expect(screenIsStale(0, SCREEN_STALE_MS - 1)).toBe(false);
    expect(screenIsStale(0, SCREEN_STALE_MS)).toBe(true);
  });
});
