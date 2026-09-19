/**
 * У каждого объявленного РОДА ЗОНЫ есть производитель.
 *
 * ── Случай 19.09 (#1957) ───────────────────────────────────────────────────
 *
 * Находка разведки просила медвежьи зоны с офлайн-доступом. Разбор показал,
 * что провод к офлайну уже проложен целиком — зоны кэшируются в localStorage,
 * руководство по медведю написано и едино на шести поверхностях, тревога
 * `bear` производится классификатором МЧС с 10.09. Не хватало ровно одного:
 * зоны рода `wildlife` не производил НИКТО.
 *
 *   export type ZoneHazard = 'volcano' | 'thermal' | 'geyser'
 *                          | 'avalanche' | 'wildlife' | 'tsunami';
 *
 * Шесть объявленных родов, четыре производимых. `wildlife` и `avalanche`
 * висели проводами в никуда — §4 CLAUDE.md, «объявленный исход без
 * источника».
 *
 * ── Почему понадобился ВТОРОЙ такой сторож ─────────────────────────────────
 *
 * Ровно этот дефект уже ловили 10.09: тип тревоги `avalanche` был объявлен в
 * ленте, для него написали инструкцию, а классификатор не выдавал его ни разу
 * (#1763). Тогда завели `alert-types-produced` — и он судит типы ЛЕНТЫ.
 * Роды ЗОН он не видит, поэтому тот же провод в геофенсе прожил ещё девять
 * дней незамеченным. Сторож, проверяющий половину связки, зеленеет ровно
 * тогда, когда отвалилась вторая.
 *
 * Список KNOWN_UNPRODUCED самоустаревающий: появился производитель — тест
 * требует убрать запись.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeZones,
  checkBreach,
  isZoneActive,
  type GeofenceZone,
} from '@/lib/safety/geofence';
import {
  bearSightingZone,
  sightingAgeLabel,
  SIGHTING_WINDOW_DAYS,
  SIGHTING_WINDOW_MS,
} from '@/lib/safety/bear-sightings';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Единственный роут, отдающий зоны клиенту. */
const ZONES_ROUTE = 'app/api/safety/geofence-zones/route.ts';
const ZONES_SRC = read(ZONES_ROUTE);
const CORE_SRC = read('lib/safety/geofence.ts');
const BEAR_SRC = read('lib/safety/bear-sightings.ts');

/**
 * Где вообще может родиться зона: роут и чистые строители, которые он зовёт.
 * Строитель, не вызванный роутом, производителем не считается — это был бы
 * тот же провод в никуда, только этажом ниже.
 */
const BUILDERS: Record<string, string> = { 'lib/safety/bear-sightings.ts': 'bearSightingZone(' };

/** Комментарии вырезаны: род, упомянутый в объяснении, производителем не является. */
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/**
 * Строитель попадает сюда ТОЛЬКО если роут его зовёт. Иначе «род производится»
 * оставалось бы правдой у функции, которую никто не вызывает, — то есть
 * сторож зеленел бы ровно в тот момент, когда зоны перестали появляться.
 */
const PRODUCER_SRC = [
  ZONES_SRC,
  ...Object.entries(BUILDERS).filter(([, call]) => ZONES_SRC.includes(call)).map(([f]) => read(f)),
].map(code).join('\n');

/** Роды, объявленные в типе — читаем из исходника, а не переписываем списком. */
function declaredHazards(): string[] {
  const m = CORE_SRC.match(/export type ZoneHazard\s*=\s*([^;]+);/);
  if (!m) throw new Error('ZoneHazard не найден — переименовали тип?');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const KNOWN_UNPRODUCED: Record<string, string> = {
  avalanche:
    'Лавинную зону не из чего построить: у лавинной опасности нет ни точки, ' +
    'ни радиуса — предупреждение МЧС называет РАЙОН словами («в горных ' +
    'районах Елизовского округа»). Тип тревоги avalanche производится с ' +
    '10.09 и доходит до человека лентой и пушем; географической зоной он ' +
    'станет, только если появится источник границ (склоны с уклоном, ' +
    'лавинные очаги УГМС). Рисовать её по догадке из текста нельзя: ложная ' +
    'граница опаснее её отсутствия.',
};

describe('у каждого рода зоны есть производитель', () => {
  const declared = declaredHazards();

  it('роды вычитаны из типа, а не выдуманы тестом', () => {
    expect(declared).toContain('volcano');
    expect(declared).toContain('wildlife');
    expect(declared.length).toBeGreaterThanOrEqual(6);
  });

  it.each(declaredHazards())('%s — либо производится, либо записан с причиной', (hazard) => {
    // Род произведён, если он присваивается полю hazard напрямую ИЛИ его
    // возвращает функция, объявленная как ZoneHazard (так приходят thermal и
    // geyser: роут выбирает род по типу места, а не пишет его литералом).
    const assigned = new RegExp(`hazard:\\s*'${hazard}'`).test(PRODUCER_SRC);
    const viaChooser = [...PRODUCER_SRC.matchAll(/\): ZoneHazard \{([\s\S]*?)\n\}/g)]
      .some((m) => m[1].includes(`'${hazard}'`));
    const produced = assigned || viaChooser;

    if (produced) {
      expect(
        KNOWN_UNPRODUCED[hazard],
        `${hazard} теперь производится — убери его из KNOWN_UNPRODUCED`,
      ).toBeUndefined();
      return;
    }
    expect(
      KNOWN_UNPRODUCED[hazard],
      `род зоны ${hazard} объявлен, но его не производит никто: ` +
      'объявленный исход без источника (§4)',
    ).toBeTruthy();
    expect(KNOWN_UNPRODUCED[hazard].length, `причина у ${hazard} пустая`).toBeGreaterThan(80);
  });

  it('строитель, которого роут не зовёт, производителем не считается', () => {
    // Иначе появился бы тот же провод в никуда, только этажом ниже: функция
    // есть, зон нет.
    for (const [file, call] of Object.entries(BUILDERS)) {
      expect(ZONES_SRC, `${file}: роут не зовёт ${call}`).toContain(call);
    }
  });

  it('выбор рода по типу места остаётся выбором, а не литералом', () => {
    expect(ZONES_SRC).toMatch(/function thermalHazard\(type: string\): ZoneHazard/);
  });
});

describe('медвежья зона строится из наблюдения, а не сочиняется', () => {
  const sighting = { id: '42', lat: 53.25, lng: 158.42, text: 'Медведица с двумя медвежатами у ручья', hoursAgo: 5 };
  const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

  it('род — wildlife, и это тот род, которого не было', () => {
    expect(bearSightingZone(sighting, NOW).hazard).toBe('wildlife');
  });

  it('подпись называет, чьё это слово и какой давности', () => {
    const z = bearSightingZone(sighting, NOW);
    expect(z.message).toContain('наблюдение туриста');
    expect(z.message).toContain('5 ч назад');
    expect(z.message).toContain('Медведица с двумя медвежатами');
  });

  it('совет берётся из общего справочника, а не пишется заново', () => {
    // Медвежья тактика на платформе одна (bear-protocol-unified). Вторая
    // копия — это расхождение в safety-контенте, оно уже случалось дважды.
    expect(bearSightingZone(sighting, NOW).message)
      .toContain('безопасной дистанции для съёмки не существует');
  });

  it('пустая цитата не подменяется придуманной', () => {
    // §4.0: пустая строка лучше придуманной. Возраст и совет остаются.
    const z = bearSightingZone({ ...sighting, text: null }, NOW);
    expect(z.message).toContain('Здесь видели медведя ·');
    expect(z.message).toContain('5 ч назад');
    expect(z.message).not.toContain('::');
  });

  it('мифическая доктрина в подпись не попала', () => {
    const m = bearSightingZone(sighting, NOW).message;
    expect(m).not.toMatch(/притвор(ись|яйся) мёртвым/i);
    expect(m).not.toMatch(/бей .*в нос/i);
  });

  it('уровень — warning: непроверенное наблюдение не заслоняет красный KVERT', () => {
    const bear = bearSightingZone(sighting, NOW);
    expect(bear.level).toBe('warning');

    const volcano: GeofenceZone = {
      id: 'volcano_1', name: 'Авачинский', lat: 53.2551, lng: 158.8306,
      radiusM: 5_000, hazard: 'volcano', level: 'critical',
      message: 'Активный вулкан — код KVERT красный.',
    };
    // Турист внутри обеих: победить обязан вулкан.
    const breach = checkBreach(53.2551, 158.8306, 10, [bear, volcano], NOW);
    expect(breach?.zone.hazard).toBe('volcano');
  });
});

describe('наблюдение — скоропортящееся, и кэш это знает', () => {
  const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
  const fresh = bearSightingZone({ id: '1', lat: 53.25, lng: 158.42, text: 'след', hoursAgo: 2 }, NOW);
  const old = bearSightingZone({ id: '2', lat: 53.25, lng: 158.42, text: 'след', hoursAgo: 24 * 6.9 }, NOW);

  const permanent: GeofenceZone = {
    id: 'place_7', name: 'Дачные источники', lat: 52.5, lng: 158.2,
    radiusM: 500, hazard: 'thermal', level: 'danger', message: 'Температура воды до 95°C.',
  };

  it('срок годности отсчитывается от НАБЛЮДЕНИЯ, а не от ответа сервера', () => {
    // Иначе каждое обновление зон продлевало бы старое наблюдение ещё на
    // неделю, и зона, однажды появившись, не исчезла бы никогда.
    expect(old.expiresAt).toBe(NOW - 24 * 6.9 * 3_600_000 + SIGHTING_WINDOW_MS);
    expect(old.expiresAt! - NOW).toBeLessThan(0.11 * 24 * 3_600_000);
  });

  it('через окно наблюдение гаснет само', () => {
    const later = NOW + SIGHTING_WINDOW_MS + 1;
    expect(isZoneActive(fresh, NOW)).toBe(true);
    expect(isZoneActive(fresh, later)).toBe(false);
  });

  it('постоянная опасность не гаснет никогда', () => {
    // Кэш зон намеренно переживает любую давность: вулкан не переедет.
    expect(permanent.expiresAt).toBeUndefined();
    expect(isZoneActive(permanent, NOW + 1000 * 24 * 3_600_000)).toBe(true);
  });

  it('истёкшая зона не даёт тревоги, даже если турист стоит в её центре', () => {
    const later = NOW + SIGHTING_WINDOW_MS + 1;
    expect(checkBreach(53.25, 158.42, 10, [fresh], NOW)?.state).toBe('inside');
    expect(checkBreach(53.25, 158.42, 10, [fresh], later)).toBeNull();
  });

  it('истёкшая не заслоняет собой действующую', () => {
    const later = NOW + SIGHTING_WINDOW_MS + 1;
    const stillHere = bearSightingZone({ id: '3', lat: 53.25, lng: 158.42, text: 'свежий', hoursAgo: 1 }, later);
    const breach = checkBreach(53.25, 158.42, 10, [fresh, stillHere], later);
    expect(breach?.zone.id).toBe('bear_3');
  });

  it('activeZones отсеивает просроченное и не трогает постоянное', () => {
    const later = NOW + SIGHTING_WINDOW_MS + 1;
    expect(activeZones([fresh, old, permanent], NOW).map((z) => z.id))
      .toEqual(['bear_1', 'bear_2', 'place_7']);
    expect(activeZones([fresh, old, permanent], later).map((z) => z.id)).toEqual(['place_7']);
  });

  it('кэш геофенса отсеивает просроченное при чтении', () => {
    // Не только при проверке близости: кэш из одних просроченных записей
    // иначе считался бы полным, и зоны молча не перезапрашивались.
    const hook = read('hooks/useGeofence.ts');
    const reader = hook.slice(hook.indexOf('function readCachedZones'), hook.indexOf('function writeCachedZones'));
    expect(reader, 'readCachedZones не фильтрует срок годности').toContain('activeZones(');
    expect(reader).toMatch(/live\.length === 0/);
  });

  it('checkBreach фильтрует сам, а не надеется на вызывающего', () => {
    const body = CORE_SRC.slice(CORE_SRC.indexOf('export function checkBreach('));
    expect(body).toContain('activeZones(zones, now)');
  });
});

describe('окно наблюдения одно на радар и на геофенс', () => {
  it('радар главной считает тем же предикатом и тем же окном', () => {
    const radar = read('app/_home/data.ts');
    expect(radar, 'своя копия предиката вернулась').toContain('${FRESH_APPROVED_SQL}');
    expect(radar).toContain('SIGHTING_WINDOW_DAYS');
    expect(radar, 'литерал INTERVAL \'7 days\' вернулся — это второе правило')
      .not.toMatch(/INTERVAL '7 days'/);
  });

  it('роут зон берёт окно оттуда же, а не пишет число', () => {
    expect(ZONES_SRC).toContain('FRESH_APPROVED_SQL');
    expect(ZONES_SRC).toContain('[SIGHTING_WINDOW_DAYS]');
    expect(ZONES_SRC, 'окно зашито числом мимо константы').not.toMatch(/INTERVAL '\d+ day/);
  });

  it('интервал приходит параметром, а не склейкой строки', () => {
    // Дублирует общий сторож намеренно: здесь SQL собирается вставкой
    // предиката, и соблазн склеить интервал ровно тут.
    expect(ZONES_SRC).not.toMatch(/INTERVAL\s*'[^']*\$\{/i);
  });

  it('окно — семь суток, как на радаре', () => {
    expect(SIGHTING_WINDOW_DAYS).toBe(7);
    expect(SIGHTING_WINDOW_MS).toBe(7 * 24 * 3_600_000);
  });

  it('подпись возраста одна на оба потребителя', () => {
    expect(sightingAgeLabel(1)).toBe('1 ч назад');
    expect(sightingAgeLabel(0.2)).toBe('1 ч назад');
    expect(sightingAgeLabel(49)).toBe('2 дн назад');
    expect(read('app/_home/data.ts')).toContain('sightingAgeLabel(');
  });
});

describe('берутся только подтверждённые наблюдения медведя', () => {
  it('модерация обязательна: pending наружу не уходит', () => {
    // Предикат общий с радаром, поэтому проверяется там, где он объявлен, и
    // отдельно — что роут берёт именно его.
    expect(BEAR_SRC).toContain("status = 'approved'");
    expect(ZONES_SRC).toContain('${FRESH_APPROVED_SQL}');
  });

  it('род фильтруется в запросе, а не после', () => {
    expect(ZONES_SRC).toMatch(/report_type = 'bear'/);
  });

  it('наблюдение без координат зоной не становится', () => {
    expect(ZONES_SRC).toMatch(/lat IS NOT NULL AND lng IS NOT NULL/);
  });
});

describe('отказ сборки зон не выдаётся за отсутствие опасностей', () => {
  it('падение запроса пишется в лог, а не молчит', () => {
    const tail = ZONES_SRC.slice(ZONES_SRC.lastIndexOf('} catch'));
    expect(tail, 'пустой catch вернулся: «зон нет» и «не смогли спросить» станут неразличимы')
      .toContain('console.error');
    expect(tail).toContain('fallback = true');
  });

  it('радар главной тоже не глушит отказ', () => {
    const radar = read('app/_home/data.ts');
    const fn = radar.slice(radar.indexOf('async function fetchReportHazards'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body, 'catch { return []; } вернулся — упавший запрос снова читается как «спокойно»')
      .not.toMatch(/catch\s*\{\s*return \[\];\s*\}/);
    expect(body).toContain('console.error');
  });
});
