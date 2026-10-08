/**
 * Кнопка «обновить данные» на экране безопасности.
 *
 * Просьба владельца 05.09 по полевому скриншоту: «чтоб сразу обращался к
 * источникам». Под ней лежит вопрос доверия, а не удобства. На экране стояло
 * «41 ч назад» — это возраст ТОЛЧКА, и по нему нельзя понять, проверяли ли мы
 * что-нибудь за эти сорок один час. Толчков просто не было, но человек в поле
 * читает такую строку как «связи нет» и перестаёт верить экрану.
 *
 * Поэтому кнопка делает две вещи: просит сервер пропустить кэш и показывает
 * время ПОСЛЕДНЕЙ ПРОВЕРКИ источника — отдельно от времени события.
 *
 * Ограничитель обязателен: экран публичный, и нетерпеливый палец не должен
 * превращаться в поток запросов к wttr.in и USGS. Забанят по адресу — данных
 * не будет ни у кого, включая того, кому они нужны на маршруте.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowFresh, lastFreshAt, resetThrottle, FRESH_MIN_INTERVAL_MS } from '@/lib/safety/refresh-throttle';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const UI = read('app/safety/_SafetyClient.tsx');
const FEED = read('lib/services/safety/seismic-feed.ts');
const WEATHER = read('app/api/safety/weather/route.ts');
const SEISMIC = read('app/api/safety/seismic/route.ts');
const WIDGET = read('lib/weather/safety-widget.ts');

describe('ограничитель обращений к чужим источникам', () => {
  beforeEach(() => resetThrottle());

  it('первое обращение проходит, повтор в окне — нет', () => {
    const now = 1_000_000;
    expect(allowFresh('weather', FRESH_MIN_INTERVAL_MS, now)).toBe(true);
    expect(allowFresh('weather', FRESH_MIN_INTERVAL_MS, now + 1_000)).toBe(false);
    expect(allowFresh('weather', FRESH_MIN_INTERVAL_MS, now + FRESH_MIN_INTERVAL_MS)).toBe(true);
  });

  it('источники считаются раздельно: погода не запирает сейсмику', () => {
    const now = 2_000_000;
    expect(allowFresh('weather', FRESH_MIN_INTERVAL_MS, now)).toBe(true);
    expect(allowFresh('seismic', FRESH_MIN_INTERVAL_MS, now)).toBe(true);
  });

  it('попытка засчитывается сразу — два одновременных запроса не пройдут оба', () => {
    const now = 3_000_000;
    const first = allowFresh('seismic', FRESH_MIN_INTERVAL_MS, now);
    const second = allowFresh('seismic', FRESH_MIN_INTERVAL_MS, now);
    expect([first, second]).toEqual([true, false]);
    expect(lastFreshAt('seismic')).toBe(now);
  });

  it('о чём не спрашивали — честный null, а не ноль', () => {
    expect(lastFreshAt('никогда-не-звали')).toBeNull();
  });
});

describe('время проверки отделено от времени события', () => {
  it('лента несёт checkedAt и признак кэша', () => {
    expect(FEED).toMatch(/checkedAt: string \| null;/);
    expect(FEED).toMatch(/fromCache: boolean;/);
  });

  it('источник не ответил — checkedAt null, а не «сейчас»', () => {
    // Пустая лента со свежим временем врёт дважды: и что данных нет, и что
    // они только что проверены.
    expect(FEED).toMatch(/source: 'none', updatedAt: new Date\(\)\.toISOString\(\), checkedAt: null/);
  });

  it('для ленты КБГС время проверки — прогон приёма, а не возраст записи', () => {
    // Прежняя редакция держала здесь `MAX(created_at)` по external_alerts и
    // называла это «временем проверки». Замер 06.09 (prod-check run 15)
    // показал цену ошибки: приём отработал минуту назад, свежайшая запись
    // землетрясения — 41-часовой давности, и экран сказал бы «проверено
    // позавчера» при живом приёме. Возраст события уже виден в самой строке
    // события; здесь нужен возраст ПРОГОНА (lib/safety/ingest-run).
    expect(FEED).toMatch(/const runAt = await lastIngestAt\(\)/);
    expect(FEED).not.toMatch(/MAX\(created_at\) AS at FROM external_alerts/);
  });
});

describe('роуты понимают «свежо», но не пускают поток наружу', () => {
  it('сейсмика спрашивает ?fresh=1 и проходит через ограничитель', () => {
    expect(SEISMIC, 'не читает ?fresh=1').toMatch(/searchParams\.get\('fresh'\) === '1'/);
    expect(SEISMIC, 'ходит к источнику без ограничителя').toMatch(/allowFresh\(/);
  });

  // Погода с 08.10 — прогноз платформы (fetchForecastDays), а не опрос wttr.in:
  // прогноз меняется раз в часы, и к источнику на нажатие кнопки не ходят
  // вовсе. Поток наружу закрыт сильнее ограничителя — запроса нет.
  it('погода к источнику на нажатие не ходит: прогноз из общего кэша', () => {
    expect(WEATHER).toMatch(/fetchForecastDays\(/);
    expect(WEATHER).not.toMatch(/\bfetch\(/);
    expect(WEATHER).not.toMatch(/searchParams/);
  });

  it('время погоды — ЧЕСТНОЕ: момент получения прогноза, а не запроса', () => {
    expect(WIDGET).toMatch(/checked_at: f\.staleSince \?\? f\.fetchedAt \?\? null/);
  });

  it('источник погоды отказал — отдаём старое, назвав его старым', () => {
    // В поле старая погода полезнее пустого экрана, но только названная старой.
    expect(WIDGET).toMatch(/stale: Boolean\(f\.staleSince\)/);
    expect(UI).toMatch(/weather\.stale && /);
  });
});

describe('экран: четыре исхода, а не два', () => {
  it('обновляем / обновлено / не смогли / нет сети — разные состояния', () => {
    expect(UI).toMatch(/'idle' \| 'loading' \| 'done' \| 'failed' \| 'offline'/);
    expect(UI).toMatch(/Источники не ответили/);
    expect(UI).toMatch(/Нет сети — показано сохранённое/);
  });

  it('офлайн проверяется ДО запроса: на маршруте это обычное состояние', () => {
    expect(UI).toMatch(/navigator\.onLine === false/);
    expect(UI.indexOf("setRefreshState('offline')")).toBeLessThan(UI.indexOf("setRefreshState('loading')"));
  });

  it('кнопка просит сервер пропустить кэш', () => {
    expect(UI).toMatch(/const q = fresh \? '1' : '0'/);
    // С 01.10 кнопка перечитывает экран целиком (reloadScreen: серверный блок
    // радара + loadAll) и передаёт «пропусти кэш» дальше в loadAll.
    expect(UI).toMatch(/reloadScreen\(true\)/);
    expect(UI).toMatch(/return loadAll\(fresh\)/);
    // Путь роута остаётся буквальным: подстановка стоит в ЗНАЧЕНИИ параметра.
    // Иначе сторож публичных вызовов читает «/api/safety/seismicX» — путь,
    // которого нет в реестре, и краснеет по делу (он это и поймал).
    expect(UI).toMatch(/fetch\(`\/api\/safety\/seismic\?fresh=\$\{q\}`\)/);
  });

  it('показывается время проверки, а не только возраст события', () => {
    // С 26.09 слово точнее: «источники опрошены» — время СБОРА, без погоды
    // (сторож safety-manual-refresh). Суть правила 05.09 та же.
    expect(UI).toMatch(/Источники опрошены \$\{fmtAgo/);
    expect(UI).toMatch(/Опрос источников ещё не удавался/);
  });

  it('вращение — утилитой Tailwind, своих @keyframes в компоненте нет', () => {
    expect(UI).toMatch(/animate-spin/);
    // Судим КОД, а не прозу: в комментарии рядом с кнопкой само правило и
    // названо, и сторож, читающий комментарии, краснел бы на объяснении.
    const code = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/@keyframes/);
  });
});
