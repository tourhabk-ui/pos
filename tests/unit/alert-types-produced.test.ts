/**
 * Каждый объявленный тип тревоги кто-то ПРОИЗВОДИТ.
 *
 * Разбор разведданной «Лавинные предупреждения» (#1428, 10.09) упёрся не в
 * отсутствие функции, а в её половину: тип `avalanche` объявлен в
 * feed-types.ts (лента безопасности его пропускает), для него написана
 * инструкция в push-copy.ts («не выходите на склоны и под них») — а в
 * классификаторе МЧС-фида нет ни `'avalanche'`, ни слова «лавин».
 * Предупреждение о лавиноопасности уходило человеку как безымянная «погода»
 * с советом про ветер, а готовая инструкция не сработала ни разу.
 *
 * То же с `landslide`. Это §4.0 в чистом виде: объявленный исход без
 * источника — провод, который никуда не подключён, и сигнализация с ним
 * выглядит исправной.
 *
 * Сторож держит две вещи:
 *   1. классификатор реально выдаёт `avalanche` и `landslide` на настоящих
 *      формулировках МЧС и не ломает соседей (вулкан с оползнями остаётся
 *      вулканом, «сельское поселение» не становится селем);
 *   2. у КАЖДОГО типа из ленты и из списка инструкций есть производитель в
 *      коде — либо он записан в KNOWN_UNPRODUCED с причиной. Список
 *      самоустаревающий: появился производитель — тест требует убрать запись.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyMchsItem } from '@/lib/services/safety/seismic-parser';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import { PUSH_TYPES_WITH_INSTRUCTION, pushCopy } from '@/lib/services/safety/push-copy';
import { alertGuidance } from '@/lib/safety/alert-guidance';

const classify = (text: string, title = '') =>
  classifyMchsItem('mchs/a', title, text, '2026-11-20T06:00:00Z', 'https://t.me/mchs41', 'tg_mchs');

// Формулировки — в жанре предупреждений МЧС по Камчатскому краю, не пересказ.
const AVALANCHE = `Экстренное предупреждение. По данным Камчатского УГМС, 20-22 ноября в горных районах Елизовского и Усть-Камчатского муниципальных округов в связи с обильными снегопадами и метелью сохраняется высокая лавинная опасность. Туристическим группам, охотникам и любителям активного отдыха воздержаться от выхода на склоны. Возможен сход снежных лавин на участки автодорог.`;

const AVALANCHE_WITH_WIND = `Штормовое предупреждение. Ночью и днём 21 ноября ожидается сильный ветер 25-30 м/с, метель. На склонах Вилючинского и Мутновского вулканов и в районе Ганальских Востряков лавиноопасно.`;

const MUDFLOW = `В связи с интенсивными осадками на реках Быстрая и Паратунка возможно формирование селевых потоков и сход оползней на участках автодорог Петропавловск-Камчатский — Мильково. Водителям соблюдать осторожность.`;

const VOLCANO_LANDSLIDE = `Сохраняется риск схода оползней и обвалов с вулкана Мутновского. Спасатели настоятельно рекомендуют не приближаться к исполину.`;

const VILLAGE = `В Соболевском сельском поселении в селе Соболево введён режим повышенной готовности в связи с выходом медведей в населённый пункт.`;

describe('лавинное предупреждение МЧС доходит своим типом', () => {
  it('классифицируется как avalanche, а не отбрасывается', () => {
    const ev = classify(AVALANCHE);
    expect(ev, 'лавинное предупреждение потерялось целиком').not.toBeNull();
    expect(ev!.alert_type).toBe('avalanche');
  });

  it('severity не ниже порога пуша: ниже двойки предупреждение есть в базе и нет на экране', () => {
    expect(classify(AVALANCHE)!.severity).toBeGreaterThanOrEqual(2);
  });

  it('вместе с ветром и метелью — всё равно лавина, а не погода', () => {
    // Ветка «сильный ветер» стоит раньше погоды и забрала бы текст себе с
    // инструкцией про ветер. Человеку на склоне нужна другая.
    expect(classify(AVALANCHE_WITH_WIND)!.alert_type).toBe('avalanche');
  });

  it('у типа есть своя инструкция, и она про склоны', () => {
    const copy = pushCopy({ alertType: 'avalanche', title: 'Лавинная опасность' });
    expect(copy.body).toMatch(/склон/);
  });
});

describe('сход грунта без вулкана — landslide', () => {
  it('сели и оползни на дорогах классифицируются как landslide', () => {
    const ev = classify(MUDFLOW);
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('landslide');
  });

  it('оползни С ВУЛКАНА остаются вулканической тревогой — прежнее поведение не тронуто', () => {
    const ev = classify(VOLCANO_LANDSLIDE);
    expect(ev!.alert_type).toBe('volcanic_eruption');
    expect(ev!.severity).toBe(2);
  });

  it('«сельское поселение» и «село» — не сель', () => {
    // Голое «сел» встречается в каждом втором тексте МЧС. Ловятся только формы
    // слова «сель»; медвежья сводка остаётся тем, чем была.
    const ev = classify(VILLAGE);
    expect(ev?.alert_type).not.toBe('landslide');
  });
});

// ── Медведи (10.09, #1792) ──────────────────────────────────────────────────
// Дайджест 10.09: «В Петропавловске-Камчатском введён режим повышенной
// готовности из-за участившихся выходов медведей». До этого дня ветка отдавала
// `info` со severity 1 — до карточек доезжало, в ленту и пуш нет, а инструкция
// для медведей из alert-guidance по типу `info` не подключалась.
const BEAR_REGIME = `В Петропавловске-Камчатском введён режим повышенной готовности в связи с участившимися выходами медведей в городскую черту. Жителям и гостям города не подходить к животным, не кормить, о встречах сообщать по телефону 112.`;

const BEAR_SIGHTING = `В районе Халактырского пляжа замечен медведь. Отдыхающим быть внимательными.`;

describe('медведи у людей — свой тип, а не info', () => {
  it('режим повышенной готовности — bear, severity 2: это решение властей о территории', () => {
    const ev = classify(BEAR_REGIME);
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('bear');
    expect(ev!.severity, 'ниже двойки нет ни пуша, ни красного статуса').toBe(2);
  });

  it('одиночный выход — bear, severity 1: карточка предупредит, пуш на весь район не нужен', () => {
    const ev = classify(BEAR_SIGHTING);
    expect(ev!.alert_type).toBe('bear');
    expect(ev!.severity).toBe(1);
  });

  it('тип доходит до ленты и до пуша', () => {
    expect(FEED_ALERT_TYPES as readonly string[]).toContain('bear');
    expect(PUSH_TYPES_WITH_INSTRUCTION as readonly string[]).toContain('bear');
  });

  it('пуш берёт инструкцию из alert-guidance, а не свою — доктрина одна', () => {
    const copy = pushCopy({ alertType: 'bear', title: 'Медведи в городе' });
    expect(copy.body).toContain(alertGuidance('bear').steps[0]);
    expect(alertGuidance('bear').known).toBe(true);
  });
});

/**
 * Файлы, которые ПРОИЗВОДЯТ тревоги (пишут alert_type в SeismicEvent /
 * external_alerts). Потребители — watchdog, лента, danger-analyst — сюда не
 * входят: сравнение `alert_type = 'x'` в WHERE производством не является.
 */
const PRODUCER_FILES = [
  'lib/services/safety/seismic-parser.ts',
  'lib/services/safety/seismic-feed.ts',
  'lib/services/safety/wildfire-firms.ts',
  'app/api/safety/volcanic/route.ts',
  'app/api/cron/safety-ingest/route.ts',
];

/**
 * Типы, объявленные без производителя, — с причиной, почему это так и что с
 * этим делать. Запись здесь — не разрешение, а видимость: разница между «не
 * шумим» и «не знаем» обязана быть видна глазами (§8, уровень known).
 *
 * Самоустаревание: как только у типа появится производитель, тест потребует
 * убрать его отсюда. Молчаливое разрешение на вечность — та же дыра.
 */
const KNOWN_UNPRODUCED: Record<string, string> = {
  ash_cloud:
    'Пепловые облака сейчас идут типом volcanic_eruption (ветка «вулкан» в ' +
    'classifyMchsItem и app/api/safety/volcanic). Отдельный тип объявлен в ' +
    'SeismicEvent, feed-types и push-copy, читается danger-analyst — но ' +
    'выделять его из вулканической ветки значит менять severity и сроки уже ' +
    'работающих тревог. Решение владельца, не побочный эффект правки 10.09.',
  volcano:
    'Есть только в FEED_ALERT_TYPES: ни производителя, ни инструкции, ни ' +
    'потребителя кроме фильтра ленты. Похоже на пережиток до разделения на ' +
    'volcanic_eruption / ash_cloud. Убрать из списка — решение владельца.',
};

describe('у каждого объявленного типа тревоги есть производитель', () => {
  const sources = PRODUCER_FILES.map((p) => readFileSync(join(process.cwd(), p), 'utf-8')).join('\n');
  const produced = (type: string) =>
    new RegExp(`alert_type\\s*[:=]\\s*'${type}'|alert_type\\s*[:=]\\s*(isAllClear|isBulletin)[^;]*'${type}'`).test(sources);

  const declared = Array.from(new Set<string>([...FEED_ALERT_TYPES, ...PUSH_TYPES_WITH_INSTRUCTION]));

  it.each(declared)('%s — либо производится, либо записан с причиной', (type) => {
    if (produced(type)) {
      expect(KNOWN_UNPRODUCED[type], `${type} теперь производится — убери его из KNOWN_UNPRODUCED`)
        .toBeUndefined();
      return;
    }
    expect(KNOWN_UNPRODUCED[type], `тип ${type} объявлен, но его не производит никто: объявленный исход без источника (§4.0)`)
      .toBeTruthy();
    expect(KNOWN_UNPRODUCED[type].length, 'причина обязана быть словами, не пометкой').toBeGreaterThan(40);
  });

  it('avalanche и landslide — больше не в списке непроизводимых', () => {
    expect(KNOWN_UNPRODUCED.avalanche).toBeUndefined();
    expect(KNOWN_UNPRODUCED.landslide).toBeUndefined();
  });
});

// ── Обратная связка: у произведённого типа есть руководство (10.09) ────────
//
// Первая половина сторожа держит «объявленное производится». Эта — «то, что
// производится, доходит до инструкции». Разбор ash_cloud показал дыру в
// потребителе: `alertGuidance('volcanic_eruption')` отвечал `known: false`,
// хотя правила МЧС при пеплопаде лежали под ключом `volcano`, а алиасы
// покрывали `ashfall` и `eruption` — имена, которых никто не производит.
// Экран планирования (_PlanningClient) зовёт alertGuidance с типом тревоги
// как есть — человек читал «у нас не записано» рядом с записанным.

/**
 * Типы, которые производятся, но руководства для которых НЕТ — с причиной.
 * Сочинять инструкцию ради зелёного теста нельзя (§4.0): «будьте осторожны»
 * на экране выглядит указанием, ничего не указывая. Список самоустаревающий:
 * появилось руководство — тест требует убрать запись.
 */
const KNOWN_WITHOUT_GUIDANCE: Record<string, string> = {
  info:
    'Нейтральный тип по замыслу: сводки, статистика, объекты «открыто/закрыто». ' +
    'У него нет опасности, к которой можно дать инструкцию.',
  road_closure:
    'Ограничение проезда — не опасность в поле, а факт о дороге; действие одно ' +
    '(«проверьте подъезд до выезда») и оно уже в push-copy. Руководство из ' +
    'нескольких шагов здесь было бы искусственным.',
  fire_danger:
    'Пожарная опасность — режим, а не событие: класс опасности и запрет на ' +
    'посещение леса. Инструкции МЧС на этот случай в репозитории нет; писать ' +
    'свою — сочинять. Появится источник — заводится блок в alert-guidance.',
  landslide:
    'Тип заведён 10.09 (#1763) с одной строкой в push-copy («обойдите склон, ' +
    'не вставайте лагерем под ним»). Многошагового руководства от МЧС нет; ' +
    'заводить блок из одной строки, переписанной второй раз, — дубль (§12).',
};

describe('у произведённого типа тревоги есть руководство — либо записано, почему нет', () => {
  const parserSource = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
  // САМОЕ ДЛИННОЕ объединение, а не первое: укороченный список стоит в шапке
  // файла как пояснение, и первый матч даёт четыре типа вместо двенадцати —
  // проверка молча ослабла бы ровно там, где должна быть строгой. Грабли
  // задокументированы в push-copy.test.ts, и я наступил на них повторно:
  // предупреждение в соседнем тесте не заменяет одинакового кода.
  const producedTypes = [
    ...([...parserSource.matchAll(/alert_type:\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/g)]
      .map((m) => m[1])
      .sort((a, b) => b.length - a.length)[0] ?? '').matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]);

  it('объединение типов из классификатора прочитано, а не выдумано', () => {
    expect(producedTypes.length).toBeGreaterThan(8);
    expect(producedTypes).toContain('volcanic_eruption');
  });

  it.each([...new Set(producedTypes)])('%s — руководство есть, либо причина записана', (type) => {
    const g = alertGuidance(type);
    if (g.known) {
      expect(KNOWN_WITHOUT_GUIDANCE[type], `${type} теперь имеет руководство — убери его из KNOWN_WITHOUT_GUIDANCE`)
        .toBeUndefined();
      expect(g.steps.length).toBeGreaterThan(0);
      return;
    }
    expect(KNOWN_WITHOUT_GUIDANCE[type], `тип ${type} производится, а руководства нет: в поле человек прочтёт «у нас не записано»`)
      .toBeTruthy();
    expect(KNOWN_WITHOUT_GUIDANCE[type].length).toBeGreaterThan(40);
  });

  it('вулканические типы ведут к правилам МЧС при пеплопаде, а не в пустоту', () => {
    expect(alertGuidance('volcanic_eruption').type).toBe('volcano');
    expect(alertGuidance('ash_cloud').type).toBe('volcano');
    expect(alertGuidance('volcanic_eruption').steps.length).toBeGreaterThan(0);
  });
});
