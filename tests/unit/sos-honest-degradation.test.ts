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
 * /emergency стали тонкими проекциями его контракта. Сторож следит, чтобы:
 *   1. семантика деградации осталась одна на оба экрана (паритет);
 *   2. на /sos не вернулось обещание, которого система не делает;
 *   3. последняя позиция оставалась честной — только валидная и не протухшая,
 *      и только как локально сохранённая точка, без обещаний передачи спасателям.
 *
 * Адреса и тексты берутся из реальных файлов, а не из копии в тесте: разъедутся
 * снова — сторож это увидит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);
const VedarGeo = requireCjs(join(ROOT, 'public/safety/geo-degradation.js')) as {
  LAST_POS_KEY: string;
  readLastKnown: (now?: number, storage?: unknown) => null | {
    lat: number; lng: number; acc: number | null; t: number; minsAgo: number; ageLabel: string;
    distanceKm?: number; distanceLabel?: string;
  };
  attachDistance: (last: unknown, curLat: number | null, curLng: number | null) => unknown;
  describeError: (code: number | string) => { code: number | string; reason: string; hint: string; retryable: boolean };
  progressLabel: (seconds: number) => string;
  saveOnlineFix: (position: unknown, online: boolean, storage?: unknown) => boolean;
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

describe('/sos не обещает того, чего не делает', () => {
  it('старого обещания «поиск идёт по последнему известному месту» больше нет', () => {
    expect(SOS).not.toMatch(/поиск идёт по последнему/);
    expect(SOS).not.toMatch(/последнему известному месту/);
  });

  it('последняя позиция рендерится под условием её существования, а не безусловным текстом', () => {
    expect(SOS, '/sos должен читать последнюю позицию через общий readLastKnown').toMatch(/readLastKnown/);
    expect(SOS, 'блок последней позиции должен быть под условием {lastKnown && ...}').toMatch(/lastKnown\s*&&/);
  });
});

describe('readLastKnown честен: точка только валидная и свежая', () => {
  const now = 1_700_000_000_000;

  it('нет ключа — null', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage(null))).toBeNull();
  });

  it('битый JSON — null', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage('{ not json'))).toBeNull();
  });

  it('координаты не числа — null', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage(JSON.stringify({ lat: 'x', lng: 2, t: now })))).toBeNull();
  });

  it('метка из будущего — null, а не «только что»', () => {
    expect(VedarGeo.readLastKnown(now, fakeStorage(JSON.stringify({ lat: 53, lng: 158, t: now + 60_000 })))).toBeNull();
  });

  it('старше суток — null', () => {
    const old = now - 25 * 60 * 60 * 1000;
    expect(VedarGeo.readLastKnown(now, fakeStorage(JSON.stringify({ lat: 53, lng: 158, t: old })))).toBeNull();
  });

  it('валидная свежая — отдаётся с давностью', () => {
    const t = now - 10 * 60 * 1000;
    const r = VedarGeo.readLastKnown(now, fakeStorage(JSON.stringify({ lat: 53.1, lng: 158.2, acc: 20, t })));
    expect(r).toBeTruthy();
    expect(r!.minsAgo).toBe(10);
    expect(r!.ageLabel).toMatch(/мин назад/);
  });
});

describe('причина отказа различима и повтор честен', () => {
  it('code 1/2/3 дают три разные причины', () => {
    const reasons = [1, 2, 3].map((c) => VedarGeo.describeError(c).reason);
    expect(new Set(reasons).size).toBe(3);
  });

  it('нет разрешения (code 1) — повтор не обещаем', () => {
    expect(VedarGeo.describeError(1).retryable).toBe(false);
  });

  it('нет сигнала (code 2) — повтор имеет смысл', () => {
    expect(VedarGeo.describeError(2).retryable).toBe(true);
  });
});

describe('последняя позиция пишется только онлайн', () => {
  const pos = { coords: { latitude: 53, longitude: 158, accuracy: 10 } };

  it('офлайн — не сохраняем: точка без сети не годится как «последний сигнал сети»', () => {
    const s = fakeStorage(null);
    expect(VedarGeo.saveOnlineFix(pos, false, s)).toBe(false);
    expect(s._raw()).toBeNull();
  });

  it('онлайн — сохраняем', () => {
    const s = fakeStorage(null);
    expect(VedarGeo.saveOnlineFix(pos, true, s)).toBe(true);
    expect(s._raw()).toContain('"lat":53');
  });
});

describe('прогресс поиска эскалирует', () => {
  it('короткое ожидание — обычный текст, долгое — призыв к повтору', () => {
    expect(VedarGeo.progressLabel(3)).toMatch(/Определяем/);
    expect(VedarGeo.progressLabel(40)).toMatch(/Повторить/);
  });
});
