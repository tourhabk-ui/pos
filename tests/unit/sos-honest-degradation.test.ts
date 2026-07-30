/**
 * Честная деградация геолокации на экстренных экранах (#897).
 *
 * Дефект: /sos и /emergency открывались офлайн оба (оба в CRITICAL_URLS), но
 * деградировали по-разному. /emergency различал причину отказа (code 1/2/3),
 * пробовал повторно и показывал последнюю известную позицию с давностью; /sos
 * показывал плоское «Недоступны» — и при этом ОБЕЩАЛ поиск по последней
 * позиции, которой у него не было. Разошлись потому, что реализованы дважды.
 *
 * Лечение — один автономный модуль public/safety/geo-degradation.js, а /sos и
 * /emergency стали тонкими проекциями его контракта. Сторож проверяет не только
 * подключение модуля, но и наблюдаемое поведение: тексты без ложных обещаний,
 * уважение флага retryable обоими экранами, чтение точки только через валидатор
 * и отсутствие гонки между попытками поиска.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);

type Coords = { lat: number; lng: number; acc: number; timestamp: number | null };
type LocState =
  | { phase: 'locating'; seconds: number }
  | { phase: 'found'; seconds: number; coords: Coords }
  | { phase: 'error'; seconds: number; error: { code: number | string; reason: string; hint: string; retryable: boolean } };

const VedarGeo = requireCjs(join(ROOT, 'public/safety/geo-degradation.js')) as {
  LAST_POS_KEY: string;
  readLastKnown: (now?: number, storage?: unknown) => null | {
    lat: number; lng: number; acc: number | null; t: number; minsAgo: number; ageLabel: string;
    distanceKm?: number; distanceLabel?: string;
  };
  attachDistance: (last: unknown, curLat: number | null, curLng: number | null) => unknown;
  describeError: (code: number | string) => { code: number | string; reason: string; hint: string; retryable: boolean };
  progressLabel: (seconds: number) => string;
  createLocator: (opts: { onState: (s: LocState) => void; geolocation?: unknown }) => { start: () => void; retry: () => void; stop: () => void };
};

const SOS = readFileSync(join(ROOT, 'app/sos/page.tsx'), 'utf-8');
const EMERGENCY = readFileSync(join(ROOT, 'public/emergency.html'), 'utf-8');
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');

/** Минимальный localStorage для проверки чистых функций без jsdom. */
function fakeStorage(initial: string | null) {
  let v = initial;
  return {
    getItem: () => v,
    setItem: (_k: string, val: string) => { v = val; },
    _raw: () => v,
  };
}

/** Управляемая заглушка geolocation: callbacks вызываем вручную. */
function fakeGeo() {
  const calls: { get: Array<{ succ: (p: unknown) => void; err: (e: unknown) => void }>; watch: number; cleared: number[] } = {
    get: [], watch: 0, cleared: [],
  };
  return {
    _calls: calls,
    getCurrentPosition(succ: (p: unknown) => void, err: (e: unknown) => void) { calls.get.push({ succ, err }); },
    watchPosition(_succ: (p: unknown) => void, _err: (e: unknown) => void) { calls.watch++; return 100 + calls.watch; },
    clearWatch(id: number) { calls.cleared.push(id); },
  };
}

describe('один модуль обслуживает оба экрана (паритет)', () => {
  it('/sos и /emergency зовут общий модуль, а не свою реализацию', () => {
    for (const [name, src] of [['/sos', SOS], ['/emergency', EMERGENCY]] as const) {
      expect(src, `${name} не подключает общий модуль geo-degradation`).toMatch(/safety\/geo-degradation\.js/);
      expect(src, `${name} не использует createLocator общего модуля`).toMatch(/createLocator/);
    }
  });

  it('модуль лежит в критичном precache — иначе офлайн у обоих экранов отвалится', () => {
    const m = /const\s+CRITICAL_URLS\s*=\s*\[([\s\S]*?)\]/.exec(SW);
    expect(m, 'CRITICAL_URLS не разобран').toBeTruthy();
    expect(m![1], 'geo-degradation.js не в CRITICAL_URLS').toMatch(/\/safety\/geo-degradation\.js/);
  });
});

describe('экраны не обещают того, чего не делают', () => {
  it('на /sos нет старого обещания «поиск идёт по последнему известному месту»', () => {
    expect(SOS).not.toMatch(/поиск идёт по последнему/);
    expect(SOS).not.toMatch(/последнему известному месту/);
  });

  it('ни один экран не утверждает, что поиск/спасатели уже идут', () => {
    // Локальная точка vedar_last_online_pos не доказывает ни передачу координат
    // спасателям, ни начатую операцию. Таких утверждений быть не должно.
    for (const [name, src] of [['/sos', SOS], ['/emergency', EMERGENCY]] as const) {
      expect(src, `${name}: «спасатели ищут» — необоснованное обещание`).not.toMatch(/спасател[а-я]*\s+ищ/i);
      expect(src, `${name}: «тебя ищут» — необоснованное обещание`).not.toMatch(/теб[яе]\s+ищ/i);
    }
  });

  it('последняя позиция на /sos рендерится под условием её существования', () => {
    expect(SOS, '/sos должен читать точку через общий readLastKnown').toMatch(/readLastKnown/);
    expect(SOS, 'блок последней позиции должен быть под условием {lastKnown && ...}').toMatch(/lastKnown\s*&&/);
  });
});

describe('оба экрана уважают retryable', () => {
  it('/sos показывает «Повторить» только когда повтор честно может помочь', () => {
    expect(SOS).toMatch(/geoError\.retryable\s*&&/);
  });

  it('/emergency показывает кнопку повтора по флагу retryable, а не всегда', () => {
    expect(EMERGENCY).toMatch(/retryable/);
    // Старое безусловное включение кнопки не должно вернуться.
    expect(EMERGENCY).not.toMatch(/retry-btn'\)\.style\.display='';/);
  });
});

describe('карты /emergency не обходят валидатор точки', () => {
  it('на /emergency нет прямого доступа к localStorage — всё через readLastKnown', () => {
    // И мини-карта, и полноэкранная раньше сами парсили localStorage: протухшая
    // или невозможная точка попала бы на карту в обход контракта. Прямого
    // доступа к хранилищу на экране больше нет — только через readLastKnown.
    expect(EMERGENCY).not.toMatch(/localStorage\.(get|set)Item/);
    expect(EMERGENCY.match(/readLastKnown/g)?.length ?? 0, 'точку должны читать все проекции').toBeGreaterThanOrEqual(3);
  });
});

describe('readLastKnown честен: точка только валидная и свежая', () => {
  const now = 1_700_000_000_000;
  const store = (o: unknown) => fakeStorage(JSON.stringify(o));

  it('нет ключа — null', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage(null))).toBeNull();
  });
  it('битый JSON — null', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage('{ not json'))).toBeNull();
  });
  it('координаты не числа — null', () => {
    expect(VedarGeo.readLastKnown(now, store({ lat: 'x', lng: 2, t: now }))).toBeNull();
  });
  it('координаты вне диапазона широты/долготы — null', () => {
    expect(VedarGeo.readLastKnown(now, store({ lat: 200, lng: 158, t: now }))).toBeNull();
    expect(VedarGeo.readLastKnown(now, store({ lat: 53, lng: 999, t: now }))).toBeNull();
  });
  it('метка из будущего — null, а не «только что»', () => {
    expect(VedarGeo.readLastKnown(now, store({ lat: 53, lng: 158, t: now + 60_000 }))).toBeNull();
  });
  it('возраст по мс, а не по округлённым минутам: 24 ч + 1 сек — null', () => {
    expect(VedarGeo.readLastKnown(now, store({ lat: 53, lng: 158, t: now - (24 * 60 * 60 * 1000 + 1000) }))).toBeNull();
  });
  it('валидная свежая — отдаётся с давностью', () => {
    const r = VedarGeo.readLastKnown(now, store({ lat: 53.1, lng: 158.2, acc: 20, t: now - 10 * 60 * 1000 }));
    expect(r).toBeTruthy();
    expect(r!.minsAgo).toBe(10);
    expect(r!.ageLabel).toMatch(/мин назад/);
  });
});

describe('модуль не пишет координаты в localStorage', () => {
  it('единственный writer точки — LastPositionTracker, у модуля только чтение', () => {
    const SRC = readFileSync(join(ROOT, 'public/safety/geo-degradation.js'), 'utf-8');
    expect(SRC).not.toMatch(/setItem/);
  });
});

describe('причина отказа различима и повтор честен', () => {
  it('code 1/2/3 дают три разные причины', () => {
    expect(new Set([1, 2, 3].map((c) => VedarGeo.describeError(c).reason)).size).toBe(3);
  });
  it('нет разрешения (code 1) — повтор не обещаем', () => {
    expect(VedarGeo.describeError(1).retryable).toBe(false);
  });
  it('нет сигнала (code 2) — повтор имеет смысл', () => {
    expect(VedarGeo.describeError(2).retryable).toBe(true);
  });
});

describe('локатор: честная оркестрация', () => {
  it('отказ в разрешении (code 1) не уходит в 30-секундный watch', () => {
    const geo = fakeGeo();
    const states: LocState[] = [];
    const loc = VedarGeo.createLocator({ geolocation: geo, onState: (s) => states.push(s) });
    loc.start();
    geo._calls.get[0].err({ code: 1 });
    expect(geo._calls.watch, 'watch при отказе разрешения не нужен').toBe(0);
    const last = states[states.length - 1];
    expect(last.phase).toBe('error');
    expect(last.phase === 'error' && last.error.code).toBe(1);
    loc.stop();
  });

  it('поздний callback прошлой попытки игнорируется (нет гонки при retry)', () => {
    const geo = fakeGeo();
    const states: LocState[] = [];
    const loc = VedarGeo.createLocator({ geolocation: geo, onState: (s) => states.push(s) });
    loc.start(); // попытка 1 → get[0]
    loc.start(); // попытка 2 (retry) → get[1]

    // Поздний успех попытки 1 не должен завершить свежий retry.
    geo._calls.get[0].succ({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: 0 });
    expect(states.some((s) => s.phase === 'found'), 'stale-callback просочился').toBe(false);

    // Успех актуальной попытки 2 — принимаем ровно один раз.
    geo._calls.get[1].succ({ coords: { latitude: 53, longitude: 158, accuracy: 5 }, timestamp: 0 });
    const found = states.filter((s): s is Extract<LocState, { phase: 'found' }> => s.phase === 'found');
    expect(found.length).toBe(1);
    expect(found[0].coords.lat).toBe(53);
    loc.stop();
  });
});

describe('прогресс поиска эскалирует', () => {
  it('короткое ожидание — обычный текст, долгое — призыв к повтору', () => {
    expect(VedarGeo.progressLabel(3)).toMatch(/Определяем/);
    expect(VedarGeo.progressLabel(40)).toMatch(/Повторить/);
  });
});
