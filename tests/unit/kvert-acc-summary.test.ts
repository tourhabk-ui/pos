/**
 * Второй формат ленты KVERT: сводная таблица кодов вместо блоков VONA.
 *
 * С 28.07.2026 источник отдаёт недельный выпуск, в котором вулканы
 * сгруппированы по цвету, а поля `Current aviation colour code:` нет вовсе.
 * Именно по нему искал прежний парсер — и распознавал ноль, а синк честно
 * отказывался писать разобранную пустоту. Отказывался правильно, но результат
 * тот же: volcano_status замер на снимке, а главная показывает вулканы только
 * с повышенным кодом, и «пусто» стало неотличимо от «спокойно».
 *
 * Фикстура — настоящая разметка, снятая с kvert.febras.net 10.08.2026 пробой
 * с раннера. Выдуманный формат в тесте на парсер источника бесполезен: он
 * проверял бы, что мы согласны сами с собой.
 */
import { describe, it, expect } from 'vitest';
import { parseAccSummary, parseVonaFeed } from '@/lib/services/safety/kvert-vona';

/** Фрагмент выпуска от 06.08.2026, как он приходит по проводу. */
const RELEASE = `
<b>Kamchatkan and Kuriles Volcanic Activity</b><br />
August 06, 2026, 23:53 UTC (August 07, 2026, 11:53 KST)<br />
<br />
KVERT monitor active volcanoes of Kamchatka and the Kurile Islands.<br />
<br />
<b>SUMMARY OF <span style="color:#0066CC">AVIATION COLOUR CODES</span>:</b><br />
<br />
 <b>KAMCHATKA</b><br />
SHEVELUCH: <span id='ORANGE'>ORANGE</span><br />
BEZYMIANNY, KRASHENINNIKOV: <span id='YELLOW'>YELLOW</span><br />
AVACHINSKY, GORELY, KARYMSKY, KLYUCHEVSKOY, KORYAKSKY, KRONOTSKY, MUTNOVSKY: <span id='GREEN'>GREEN</span><br />
<br />
 <b>NORTHERN KURILES</b><br />
ALAID, CHIKURACHKI, EBEKO: <span id='GREEN'>GREEN</span><br />
<br />
Dr. Olga A. Girina, Head of KVERT, IVS FEB RAS<br />
E-mail: girina@kscnet.ru<br />
Tel.: +74152202044<br />
`;

describe('сводка разбирается по факту, а не по догадке', () => {
  const parsed = parseAccSummary(RELEASE);

  it('Шивелуч оранжевый — тот самый код, который у нас был заморожен', () => {
    const sh = parsed.find(v => v.nameSlug === 'sheveluch');
    expect(sh, 'Шивелуч потерялся — KVERT пишет SHEVELUCH, не Shiveluch').toBeDefined();
    expect(sh!.color).toBe('orange');
    expect(sh!.nameRu).toBe('Шивелуч');
  });

  it('строка с несколькими именами раскрывается в отдельные вулканы', () => {
    expect(parsed.find(v => v.nameSlug === 'bezymianny')?.color).toBe('yellow');
    // До 02.09 KRASHENINNIKOV служил здесь примером НЕЗНАКОМОГО имени. Алиас
    // добавлен после миграции 927 (до неё место звалось «Вулкан Крашенникова»
    // и алиас был бы бесполезен). Теперь он знаком — и жёлтый.
    const kr = parsed.find(v => v.volcanoName === 'KRASHENINNIKOV');
    expect(kr).toBeDefined();
    expect(kr!.nameSlug).toBe('krasheninnikov');
    expect(kr!.nameRu).toBe('Крашенинников');
    expect(kr!.color).toBe('yellow');
  });

  it('незнакомое имя приезжает без slug, а не теряется', () => {
    // GAMCHEN — из живого списка «нет в алиасах» прогона 02.09; разметка та
    // же, что в фикстуре выше. Правило прежнее, пример сменён: прежний
    // (Крашенинников) стал знакомым.
    // Парсер якорится на маркере «AVIATION COLOUR CODES» — без него
    // возвращает пусто. Первая версия этого теста маркер не несла и упала
    // на «ничего не нашёл» — не потому, что имя терялось, а потому что
    // разбор не начинался. Строка должна быть той же формы, что и выпуск.
    const line = [
      `<b>SUMMARY OF AVIATION COLOUR CODES:</b><br />`,
      `<b>KAMCHATKA</b><br />`,
      `GAMCHEN: <span id='YELLOW'>YELLOW</span><br />`,
    ].join('\n');
    const g = parseAccSummary(line).find(v => v.volcanoName === 'GAMCHEN');
    expect(g).toBeDefined();
    expect(g!.nameSlug).toBeNull();
    expect(g!.color).toBe('yellow');
  });

  it('зелёные тоже записываются — молчание о них и есть устаревший зелёный', () => {
    for (const slug of ['avachinsky', 'karymsky', 'klyuchevskoy', 'koryaksky', 'mutnovsky']) {
      expect(parsed.find(v => v.nameSlug === slug)?.color, slug).toBe('green');
    }
  });

  it('Курилы разбираются наравне с Камчаткой', () => {
    expect(parsed.find(v => v.nameSlug === 'alaid')?.color).toBe('green');
    expect(parsed.find(v => v.nameSlug === 'ebeko')?.color).toBe('green');
  });

  it('дата выпуска берётся из шапки — иначе проверка устаревания слепа', () => {
    const at = parsed[0].observedAt;
    expect(at).toBeInstanceOf(Date);
    expect(at!.toISOString()).toBe('2026-08-06T23:53:00.000Z');
  });

  it('чего в сводке нет, то и не выдумывается', () => {
    const sh = parsed.find(v => v.nameSlug === 'sheveluch')!;
    expect(sh.previousColor).toBeNull();
    expect(sh.ashHeightM).toBeNull();
    expect(sh.summitElevationM).toBeNull();
    expect(sh.summary).toBeNull();
  });
});

describe('разбор консервативен — лишнего не берёт', () => {
  it('контакты и подписи после сводки в вулканы не превращаются', () => {
    const names = parseAccSummary(RELEASE).map(v => v.volcanoName);
    expect(names.join(' ')).not.toMatch(/Girina|E-mail|Tel|KVERT/i);
  });

  it('страница без сводки даёт пусто, а не мусор', () => {
    expect(parseAccSummary('<html><body>Ничего похожего</body></html>')).toEqual([]);
    expect(parseAccSummary('')).toEqual([]);
  });

  it('строка «ИМЯ: не цвет» не считается кодом', () => {
    const fake = `SUMMARY OF AVIATION COLOUR CODES:<br />CONTACT: Girina<br />`;
    expect(parseAccSummary(fake)).toEqual([]);
  });

  it('один вулкан не приезжает дважды под двумя написаниями', () => {
    const dup = `SUMMARY OF AVIATION COLOUR CODES:<br />
      SHEVELUCH: <span id='ORANGE'>ORANGE</span><br />
      SHIVELUCH: <span id='ORANGE'>ORANGE</span><br />`;
    expect(parseAccSummary(dup).filter(v => v.nameSlug === 'sheveluch')).toHaveLength(1);
  });
});

describe('прежний формат не сломан', () => {
  it('блоки VONA по-прежнему разбираются своим парсером', () => {
    const vona = [
      'VOLCANO OBSERVATORY NOTICE FOR AVIATION (VONA)',
      'Volcano: Sheveluch (CAVW #300270)',
      'Current aviation colour code: ORANGE',
      'Previous aviation colour code: YELLOW',
      'Summit Elevation: 3283 m',
    ].join('\n');
    const parsed = parseVonaFeed(vona);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].color).toBe('orange');
    expect(parsed[0].previousColor).toBe('yellow');
  });

  it('адрес просит английскую версию — иначе разбор развалится молча', () => {
    // Русская версия той же страницы отдаётся в однобайтовой кодировке:
    // цветовые слова (латиница) продолжат находиться, а имена вулканов — нет,
    // и синк отчитается разобранной пустотой вместо явного отказа. Проба 10.08
    // видела там шесть ORANGE и восемь YELLOW при нуле найденных имён.
    expect(readSync()).toMatch(/lend=en/);
  });

  it('сводка не подменяет VONA там, где VONA есть', () => {
    // Синк пробует VONA первым: он богаче — высота пепла, предыдущий код,
    // текст. Проверка живёт здесь, потому что порядок и есть решение.
    const src = readSync();
    const vonaAt = src.indexOf('parseVonaFeed(text)');
    const summaryAt = src.indexOf('parseAccSummary(text)');
    expect(vonaAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(vonaAt);
  });
});

function readSync(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(process.cwd(), 'lib/agents/kvert-sync.ts'), 'utf-8');
}

describe('сущности разворачиваются один раз', () => {
  it('&amp;lt; остаётся текстом «&lt;», а не превращается в «<»', () => {
    // Цепочка из .replace() по одной сущности разворачивает дважды: сперва
    // &amp; даёт &, следующий шаг видит готовое &lt; и делает из него <.
    // На это указал CodeQL. Двойное разворачивание опасно тем, что выглядит
    // как работающий код.
    const src = `SUMMARY OF AVIATION COLOUR CODES:<br />
      A&amp;lt;B: <span id='GREEN'>GREEN</span><br />`;
    const names = parseAccSummary(src).map(v => v.volcanoName);
    expect(names.join(' ')).not.toContain('<');
  });

  it('обычные сущности всё же разворачиваются', () => {
    const src = `SUMMARY OF AVIATION COLOUR CODES:<br />
      SHEVELUCH&nbsp;: <span id='ORANGE'>ORANGE</span><br />`;
    // Неразвёрнутый &nbsp; оставил бы в имени мусор и сорвал сопоставление.
    expect(parseAccSummary(src).find(v => v.nameSlug === 'sheveluch')?.color).toBe('orange');
  });
});
