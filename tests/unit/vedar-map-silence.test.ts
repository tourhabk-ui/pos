/**
 * Молчание карты — не исход.
 *
 * Полевой прогон 01.09, скрин владельца с Авачинского перевала: между
 * компасом и карточкой расстояния чёрное поле. Ни рельефа, ни трека, ни
 * строки ошибки, ни строки «Подложка OSM: …». Приложение при этом работало:
 * GPS ±30 м, азимут, 15.6 км до следующей точки — всё живое.
 *
 * У карты было ровно два исхода: «рисую» и «сказала ошибку». Случившийся
 * третий — смонтировалась, не упала, тайлы не пришли — на экране выглядел
 * как фон страницы того же цвета `#0D1117`. Отличить его человеку в поле
 * было нечем, и разбор пошёл перепиской со скринами вместо одного взгляда.
 *
 * Это ровно §4.0: у проверки обязан быть исход «не смог», и он обязан
 * отличаться от «хорошо». Сторож держит три вещи:
 *   - карта считает, пришёл ли КАЖДЫЙ источник, а не «была ли ошибка»
 *     (при чтении PMTiles своим протоколом отказ до события `error` может
 *     не дойти вовсе — 01.09 он и не дошёл);
 *   - счёт идёт в ref, не в state: событий `data` сотни, и перерисовка на
 *     каждом вернула бы скачущую карту, которую чинили тем же утром;
 *   - сторож молчит, когда всё хорошо, и снимается при размонтировании.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packFileName, probeFetch, probeWorker, webglReport } from '@/components/shared/VedarMap';

const SRC = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const CLIENT_SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('карта отчитывается о себе, когда ничего не нарисовала', () => {
  it('считает приход каждого источника поимённо', () => {
    // «Рельеф не пришёл» и «горизонтали не пришли» — разные поломки с
    // разными причинами: один читается Range-запросами из архива, другой
    // обычным GET. Общее «карта не работает» не назвало бы ни одну.
    expect(SRC).toMatch(/sourceId === 'terrain'/);
    expect(SRC).toMatch(/sourceId === 'contours'/);
    expect(SRC).toMatch(/рельеф не пришёл/);
    expect(SRC).toMatch(/горизонтали не пришли/);
    expect(SRC).toMatch(/стиль не загрузился/);
  });

  it('судит по приходу данных, а не только по событию ошибки', () => {
    // 01.09 событие error не сработало ни разу, а карты не было.
    expect(SRC).toMatch(/map\.on\('data'/);
  });

  it('счётчики живут в замыкании, а не в state', () => {
    // Событий data сотни. setState на каждом — это пересборка карты на
    // каждом тайле, та же болезнь, что чинили в LeafletMap 31.08.
    const at = SRC.indexOf("map.on('data'");
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 400);
    expect(body).not.toMatch(/setDiag|setState|setReady/);
  });

  it('сторож снимается при размонтировании', () => {
    // Иначе таймер стрельнёт по мёртвому компоненту и попробует обновить
    // размонтированное состояние.
    expect(SRC).toMatch(/clearTimeout\(watchdog\)/);
  });

  it('молчит, когда всё хорошо', () => {
    // Сообщение без повода читается как шум, и через неделю его перестают
    // замечать — тогда оно не сработает и в настоящий раз.
    expect(SRC).toMatch(/if \(loaded && seen\.terrain > 0\) return;/);
  });

  it('отчёт называет файл пакета, а не только факт отказа', () => {
    expect(SRC).toMatch(/искала: \{packFileName/);
  });
});

describe('сообщение доходит туда, где его не накроет карточка статуса', () => {
  /**
   * Регресс того же дня: строка была НА карте, но карта — `fixed inset-0
   * z-0`, а приборная колонка со статусом — `z-10`, СОСЕДНИЙ стекинг-
   * контекст. Дочерний z-index внутри z-0 не может перекрыть родителя
   * соседа, сколько его ни поднимай, — и текст оказался под непрозрачной
   * карточкой, видна была только полоска в 1-2 пикселя.
   *
   * Лечится не CSS-трюком внутри карты, а тем же приёмом, что уже применён
   * для `fieldBaseMap.reason` («Подложка OSM: …»): сообщение выходит из
   * карты наружу и рисуется в самой приборной колонке.
   */
  it('VedarMap принимает onDiagnostic и вызывает его при смене mapError/diag', () => {
    expect(SRC).toMatch(/onDiagnostic\?:\s*\(message: string \| null\) => void/);
    // 03.09: к ошибке и диагнозу добавились заметки (гипсометрия снята,
    // вид вне пакета) — канал наружу один на всех.
    const at = SRC.indexOf('onDiagnosticRef.current?.(mapError ?? diag ?? reliefNote ?? viewNote ?? null)');
    expect(at, 'эффект, синхронизирующий диагноз наружу, не найден').toBeGreaterThan(0);
  });

  it('callback идёт через ref, а не напрямую в зависимостях — жизненный цикл карты не должен дёргаться от чужой identity', () => {
    expect(SRC).toMatch(/const onDiagnosticRef = useRef\(onDiagnostic\)/);
  });

  it('очистка при размонтировании — отдельным эффектом, не при каждой смене диагноза', () => {
    const at = SRC.indexOf('() => onDiagnosticRef.current?.(null), []');
    expect(at, 'unmount-эффект очистки не найден').toBeGreaterThan(0);
  });

  it('_PlanningClient рисует диагноз в приборной колонке (z-10), а не только внутри VedarMap', () => {
    expect(CLIENT_SRC).toMatch(/onDiagnostic=\{setVedarDiag\}/);
    const at = CLIENT_SRC.indexOf("fieldBaseMap.kind === 'vedar' && vedarDiag");
    expect(at, 'строка диагноза в приборной колонке не найдена').toBeGreaterThan(0);
    // 03.09: заметка может прийти и от РИСУЮЩЕЙ карты (гипсометрия снята,
    // вид вне пакета) — префикс без «не отрисовалась».
    expect(CLIENT_SRC.slice(at, at + 400)).toMatch(/Своя карта: \{vedarDiag\}/);
  });
});

describe('молчание карты кончается самопроверкой, а не догадкой', () => {
  /**
   * Вечер 01.09: сторож назвал «стиль не загрузился · рельеф не пришёл ·
   * горизонтали не пришли» — и на этом знание кончалось. Почему — знал
   * только браузер телефона: preflight на заголовок Range, CORS, 403
   * бакета и обрыв сети снаружи неотличимы, а раннер ходит из другой сети.
   * Карта обязана спросить сама и напечатать ответ.
   */
  it('спрашивает оба файла тем же способом, что читатель PMTiles', () => {
    // Заголовок архива — первый запрос читателя (getBytes(0, 16384)).
    expect(SRC).toMatch(/probeFetch\(rawTerrain, 'bytes=0-16383'\)/);
    expect(SRC).toMatch(/probeFetch\(sources\.contoursUrl, 'bytes=0-1023'\)/);
    // Схема pmtiles:// — для MapLibre, а не для fetch.
    expect(SRC).toMatch(/replace\(\/\^pmtiles:\\\/\\\/\/, ''\)/);
  });

  it('поздний приход рельефа снимает сообщение — слабый канал не отказ', () => {
    expect(SRC).toMatch(/if \(diagShown\) \{ diagShown = false; setDiag\(null\); \}/);
    // Ответ самопроверки, пришедший после того как рельеф уже нарисовался,
    // не должен воскрешать сообщение.
    expect(SRC).toMatch(/if \(cancelled \|\| !diagShown\) return;/);
  });

  it('probeFetch шлёт Range через CORS и отвечает кодом', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { status: 206 } as Response;
    }) as unknown as typeof fetch;
    const out = await probeFetch('https://s3.example.ru/b/a.pmtiles', 'bytes=0-16383', fake);
    expect(out).toMatch(/^HTTP 206 за \d+\.\d с$/);
    expect(calls).toHaveLength(1);
    expect((calls[0][1]?.headers as Record<string, string>).range).toBe('bytes=0-16383');
    expect(calls[0][1]?.mode).toBe('cors');
  });

  it('probeFetch называет исключение по имени — это и есть диагноз CORS/preflight', async () => {
    const fake = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const out = await probeFetch('https://s3.example.ru/b/a.pmtiles', 'bytes=0-1', fake);
    expect(out).toMatch(/^TypeError: Failed to fetch через \d+\.\d с$/);
  });

  it('probeFetch отдаёт 403/404 кодом, не исключением — у них другое лекарство', async () => {
    const fake = (async () => ({ status: 403 }) as Response) as unknown as typeof fetch;
    const out = await probeFetch('https://s3.example.ru/b/a.pmtiles', 'bytes=0-1', fake);
    expect(out).toMatch(/^HTTP 403 за/);
  });
});

describe('сеть отвечает, а карта молчит — телефон проверяет себя, а не бакет', () => {
  /**
   * Утро 02.09 (Камчатка): самопроверка сети дала «HTTP 206 за 0.2 с» по
   * обоим файлам — и карта всё равно молчала. Значит беда не снаружи, а
   * в том, что знает только этот браузер: воркер, WebGL2, CSP, TileJSON.
   * Общее у трёх молчащих слоёв — воркер: геоджсон режется в нём, тайлы
   * рельефа декодируются в нём, без него `load` не наступает никогда, а
   * `error` не звучит.
   */
  it('спрашивает воркер напрямую, тем же blob:, что MapLibre', () => {
    expect(SRC).toMatch(/new Worker\(URL\.createObjectURL\(new Blob\(/);
    expect(SRC).toMatch(/probeWorker\(\)/);
  });

  it('слушает нарушения CSP от самого браузера и снимает слушатель', () => {
    // Вечер 01.09: запрет воркера из blob: нашли по коду next.config.js, а
    // браузер всё это время ЗНАЛ директиву и адрес — его не спрашивали.
    expect(SRC).toMatch(/document\.addEventListener\('securitypolicyviolation', onCsp\)/);
    expect(SRC).toMatch(/document\.removeEventListener\('securitypolicyviolation', onCsp\)/);
  });

  it('запрошенные тайлы считаются отдельно от пришедших', () => {
    // Ноль запросов — TileJSON не получен (протокол PMTiles); запросы есть,
    // пришедших нет — не декодируется (воркер). Разные лекарства.
    expect(SRC).toMatch(/map\.on\('dataloading'/);
    expect(SRC).toMatch(/тайлов рельефа запрошено \$\{seen\.terrainRequested\}, пришло \$\{seen\.terrain\}/);
  });

  it('говорит, дошёл ли стиль, и упоминает WebGL2', () => {
    expect(SRC).toMatch(/map\.isStyleLoaded\(\)/);
    expect(SRC).toMatch(/map\.on\('styledata'/);
    expect(SRC).toMatch(/webglReport\(\)/);
  });

  it('probeWorker: ответивший воркер — «отвечает»', async () => {
    const fake = () => {
      const w = { onmessage: null as null | ((e: unknown) => void), onerror: null, terminate: () => {} };
      setTimeout(() => w.onmessage?.({ data: 'ok' }), 5);
      return w as unknown as Worker;
    };
    expect(await probeWorker(500, fake)).toMatch(/^воркер отвечает за \d+\.\d с$/);
  });

  it('probeWorker: молчащий воркер — «молчит», а не вечное ожидание', async () => {
    const fake = () => ({ onmessage: null, onerror: null, terminate: () => {} }) as unknown as Worker;
    expect(await probeWorker(50, fake)).toMatch(/^воркер молчит \d+\.\d с$/);
  });

  it('probeWorker: скрипт воркера упал — текст ошибки на экран', async () => {
    const fake = () => {
      const w = { onmessage: null, onerror: null as null | ((e: unknown) => void), terminate: () => {} };
      setTimeout(() => w.onerror?.({ message: 'Uncaught SyntaxError' }), 5);
      return w as unknown as Worker;
    };
    expect(await probeWorker(500, fake)).toBe('воркер упал: Uncaught SyntaxError');
  });

  it('probeWorker: конструктор бросил (CSP, старый WebView) — «не создался» с именем', async () => {
    const fake = () => { throw new DOMException('Failed to construct Worker', 'SecurityError'); };
    expect(await probeWorker(500, fake)).toBe('воркер не создался: SecurityError: Failed to construct Worker');
  });

  it('webglReport: без контекста — «недоступен», с контекстом — имя рендерера', () => {
    const none = () => ({ getContext: () => null }) as unknown as HTMLCanvasElement;
    expect(webglReport(none)).toBe('WebGL2 недоступен');
    const some = () => ({
      getContext: () => ({
        RENDERER: 7937,
        getExtension: () => null,
        getParameter: () => 'Adreno (TM) 650',
      }),
    }) as unknown as HTMLCanvasElement;
    expect(webglReport(some)).toBe('WebGL2 есть (Adreno (TM) 650)');
  });
});

describe('имя пакета в отчёте читаемо на телефоне', () => {
  it('снимает схему pmtiles и хост', () => {
    expect(packFileName('pmtiles://https://s3.example.ru/bucket/avacha.terrain.pmtiles'))
      .toBe('avacha.terrain.pmtiles');
  });

  it('снимает параметры запроса — в них бывают ключи', () => {
    expect(packFileName('https://s3.example.ru/b/avacha.contours.geojson?sig=abc'))
      .toBe('avacha.contours.geojson');
  });

  it('обычный адрес без схемы pmtiles тоже сокращает', () => {
    expect(packFileName('https://s3.example.ru/b/avacha.contours.geojson'))
      .toBe('avacha.contours.geojson');
  });

  it('пустой хвост не превращается в пустую строку', () => {
    // Пустая строка в отчёте выглядела бы как «искала: » — вопрос без
    // ответа. Лучше вернуть то, что есть.
    expect(packFileName('https://s3.example.ru/')).toBe('s3.example.ru');
  });
});
