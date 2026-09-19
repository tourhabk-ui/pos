/**
 * Сторож приёмника спутникового трекера.
 *
 * Решение владельца 19.09 («делай пок 3»): точка с трекера должна доходить
 * до регистрации маршрута, когда телефон молчит. Приёмник публичный — токен
 * в адресе единственное доказательство права писать, — и пишет он то, по
 * чему человека будут искать. Значит соврать он может дорого.
 *
 * Сторож держит ровно те способы соврать:
 *   — принять мусор за координату (ноль, перепутанные широта с долготой);
 *   — выдать вчерашнюю точку за «где он сейчас»;
 *   — молча превратить непонятное время в «сейчас»;
 *   — смешать «формы не знаем» с «точка плохая»: чинятся они в разных местах;
 *   — затереть свежую точку пришедшей позже старой;
 *   — проглотить отказ, которого человек не увидит (ответ читает железо).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseTrackerPoint, MAX_POINT_AGE_MS, KRAI_LAT_MIN, KRAI_LAT_MAX,
} from '@/lib/safety/tracker-point';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const PKC = { lat: 53.01, lng: 158.65 };

describe('разбор точки трекера', () => {
  it('нормализованная точка проходит', () => {
    const v = parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng }, NOW);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.lat).toBe(PKC.lat);
      expect(v.lng).toBe(PKC.lng);
      // Времени в теле не было — моментом считается приём.
      expect(v.at.getTime()).toBe(NOW);
    }
  });

  it('имена полей терпимы к регистру и синонимам', () => {
    // Это НЕ поддержка вендора, а признание того, что lat/latitude/Latitude —
    // одно слово. Проверяемо без единого трекера в руках.
    for (const body of [
      { latitude: PKC.lat, longitude: PKC.lng },
      { Latitude: PKC.lat, Longitude: PKC.lng },
      { lat: String(PKC.lat), lon: String(PKC.lng) },
    ]) {
      expect(parseTrackerPoint(body, NOW).kind, JSON.stringify(body)).toBe('ok');
    }
  });

  it('координат не нашлось — это «не знаем формы», а НЕ «точка плохая»', () => {
    // Разница решающая: unknown чинится в настройках шлюза, rejected — у
    // прибора. Слить их значит чинить не то.
    const v = parseTrackerPoint({ Events: [{ Point: { Latitude: 53 } }] }, NOW);
    expect(v.kind).toBe('unknown');
  });

  it('тело не объект — тоже «не знаем формы»', () => {
    expect(parseTrackerPoint(null, NOW).kind).toBe('unknown');
    expect(parseTrackerPoint('53.01,158.65', NOW).kind).toBe('unknown');
    expect(parseTrackerPoint([PKC.lat, PKC.lng], NOW).kind).toBe('unknown');
  });

  it('точка вне края отклоняется с причиной', () => {
    const v = parseTrackerPoint({ lat: 0, lng: 0 }, NOW);
    expect(v.kind).toBe('rejected');
    if (v.kind === 'rejected') expect(v.reason).toContain('вне Камчатского края');
  });

  it('перепутанные местами широта и долгота не проходят', () => {
    // 158 широты не бывает — самый частый мусор, и конверт ловит именно его.
    expect(parseTrackerPoint({ lat: PKC.lng, lng: PKC.lat }, NOW).kind).toBe('rejected');
    expect(KRAI_LAT_MAX).toBeLessThan(90);
    expect(KRAI_LAT_MIN).toBeGreaterThan(0);
  });

  it('точка старше суток свежей не считается', () => {
    const old = new Date(NOW - MAX_POINT_AGE_MS - 60_000).toISOString();
    const v = parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at: old }, NOW);
    expect(v.kind).toBe('rejected');
    if (v.kind === 'rejected') expect(v.reason).toContain('старше суток');
  });

  it('накопленная за ночь пачка проходит: сутки — это запас, а не придирка', () => {
    const yesterdayEvening = new Date(NOW - 10 * 3_600_000).toISOString();
    expect(parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at: yesterdayEvening }, NOW).kind).toBe('ok');
  });

  it('время из будущего отклоняется', () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at: future }, NOW).kind).toBe('rejected');
  });

  it('малое расхождение часов прощается', () => {
    const skew = new Date(NOW + 60_000).toISOString();
    expect(parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at: skew }, NOW).kind).toBe('ok');
  });

  it('непонятное время — отказ, а не молчаливое «сейчас»', () => {
    // Подставить приём вместо неразобранного времени значит сделать
    // протухшую точку свежей.
    const v = parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at: 'позавчера' }, NOW);
    expect(v.kind).toBe('rejected');
    if (v.kind === 'rejected') expect(v.reason).toContain('время');
  });

  it('секунды и миллисекунды различаются по порядку числа', () => {
    const sec = Math.floor((NOW - 3_600_000) / 1000);
    const ms = NOW - 3_600_000;
    for (const at of [sec, ms]) {
      const v = parseTrackerPoint({ lat: PKC.lat, lng: PKC.lng, at }, NOW);
      expect(v.kind, String(at)).toBe('ok');
      if (v.kind === 'ok') expect(v.at.getTime()).toBe(ms);
    }
  });
});

describe('приёмник не теряет и не путает', () => {
  const route = readFileSync(
    join(process.cwd(), 'app/api/safety/tracker/[token]/route.ts'), 'utf8',
  );

  it('старая точка не затирает свежую', () => {
    // Трекер вываливает накопленное пачкой, и порядок в ней не гарантирован.
    // «Последняя известная точка» обязана быть последней ПО ВРЕМЕНИ.
    expect(route).toMatch(/last_position_at IS NULL OR last_position_at < \$4/);
  });

  it('источник точки записывается явно', () => {
    // Иначе точка с трекера неотличима от точки с телефона, а для того, кто
    // едет искать, это разные факты.
    expect(route).toMatch(/last_position_source = 'tracker'/);
  });

  it('отказ оседает в связке, а не только в ответе', () => {
    // Ответ приёмника человек не видит никогда — его читает железо.
    expect(route).toContain('noteError');
    expect(route).toMatch(/last_error = LEFT\(\$2, 300\)/);
  });

  it('отказ базы отвечает 503, а не 4xx', () => {
    // Шлюзы вендоров повторяют отправку на 5xx и не повторяют на 4xx:
    // перепутать значит потерять точку насовсем.
    const dbFail = route.slice(route.indexOf('связка не прочиталась'));
    expect(dbFail.slice(0, 400)).toContain('status: 503');
  });

  it('несуществующий и отозванный токен отвечают по-разному', () => {
    // 404 — «такого адреса нет», 410 — «был и закрыт»: разные починки.
    expect(route).toMatch(/Связка не найдена[\s\S]{0,80}404/);
    expect(route).toMatch(/Связка отозвана[\s\S]{0,80}410/);
  });

  it('счётчик растёт даже когда точка не легла в маршрут', () => {
    // Исправный трекер, догоняющий очередь, иначе показывался бы молчащим.
    expect(route).toMatch(/points_total = points_total \+ 1/);
    expect(route).toContain('stored:');
  });
});

describe('механизм собран целиком', () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  it('публичный адрес объявлен в реестре — иначе Edge закроет приёмник', () => {
    const registry = read('lib/auth/public-api-routes.ts');
    expect(registry).toMatch(/'\/api\/safety\/tracker\/\*': \['POST'\]/);
  });

  it('у приёмника есть производитель токена', () => {
    // Приёмник без того, кто заводит связку, — провод в никуда (§10.09).
    const producer = read('app/api/safety/tracker-links/route.ts');
    expect(producer).toContain('randomBytes(32)');
    expect(producer).toContain('/api/safety/tracker/');
  });

  it('чужой маршрут трекером не подключить', () => {
    const producer = read('app/api/safety/tracker-links/route.ts');
    expect(producer).toContain('ownRegistration');
    expect(producer).toMatch(/user_id::text = \$2/);
  });

  it('токен не отдаётся в списке — только при создании', () => {
    const producer = read('app/api/safety/tracker-links/route.ts');
    const getBlock = producer.slice(producer.indexOf('export async function GET'), producer.indexOf('export async function POST'));
    expect(getBlock).not.toMatch(/\btoken\b/);
  });

  it('потребитель точки — сторож невозврата, и он видит источник', () => {
    const watchdog = read('app/api/cron/checkin-watchdog/route.ts');
    expect(watchdog).toContain('last_position_source');
    const escalation = read('lib/safety/checkin-escalation.ts');
    expect(escalation).toContain('спутниковый трекер');
    // Источник не записан — молчим, а не приписываем телефон.
    expect(escalation).toContain('source === \'phone\'');
  });
});
