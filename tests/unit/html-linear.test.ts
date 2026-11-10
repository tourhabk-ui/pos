/**
 * Разметка снимается за линейное время, а текст — тот же (lib/html/text.js).
 *
 * Находка проверки 10.11: регулярки разбора на повреждённой странице работали
 * за квадрат. Замер: `stripTags` на 600 тыс. знаков из одних `<a ` без `>` —
 * 44 секунды, `stripScriptsAndStyles` на 800 тыс. из `<script ` — минута.
 * Разбор синхронный, сервер прода — один процесс: пока он занят, не отвечает
 * ничего, включая SOS. Чужую страницу сюда приносят кроны разведки и прогноза,
 * наблюдение за сайтами партнёров (до 3 млн знаков по адресу, который партнёр
 * вписал сам) и ещё десятки мест.
 *
 * Держит две вещи разом:
 *  - текст тот же, что давали прежние регулярки, — иначе разом сменились бы
 *    снимки страниц под наблюдением, описания и всё, что прошло через разбор.
 *    Прежние регулярки заморожены здесь эталоном; сверка — на случайной
 *    разметке из обломков тегов и на странице, обрезанной на каждом знаке;
 *  - повреждённая страница разбирается за доли секунды.
 *
 * Независимая проверка этой правки нашла три слабых места первой редакции
 * сторожа, и все три здесь закрыты: генератор образцов вырождался (из 30 тыс.
 * строк разных было 1 433 — так в #3202 прошло расхождение обходного слоя);
 * эталон брал число витков из проверяемого модуля; одна из форм у прежнего
 * разбора была не квадратом, а кубом и при возврате регулярки вешала бы прогон
 * на часы, не давая ему покраснеть.
 */
import { describe, it, expect } from 'vitest';
import { stripTags, stripScriptsAndStyles, htmlToText, MAX_PASSES } from '@/lib/html/text';
import { fullPageText, WATCH_BODY_LIMIT } from '@/lib/partners/site-watch';

// ── Эталон: разбор, каким он был до 10.11. Не править — с ним сверяется новый. ──

/** Число витков эталона записано числом: взятое из проверяемого модуля менялось бы вместе с ним. */
const REF_MAX_PASSES = 5;
const REF_TAG = /<\/?[a-zA-Z][^>]*>/g;
const REF_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

function refStripScriptsAndStyles(html: string, separator = ' '): string {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, separator)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, separator)
    .replace(/<script\b[^>]*>[\s\S]*$/i, separator)
    .replace(/<style\b[^>]*>[\s\S]*$/i, separator);
}

function refStripTags(html: string, separator = ''): string {
  let out = refStripScriptsAndStyles(String(html), separator).replace(REF_COMMENT, separator);
  for (let i = 0; i < REF_MAX_PASSES; i++) {
    const next = out.replace(REF_TAG, separator);
    if (next === out) break;
    out = next;
  }
  return out.replace(/<\/?[a-zA-Z][^>]*$/, separator);
}

function refHtmlToText(html: string): string {
  const withBreaks = refStripScriptsAndStyles(String(html), ' ')
    .replace(REF_COMMENT, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  return refStripTags(withBreaks, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Случайная разметка ───────────────────────────────────────────────────────

const TOKENS = [
  '<script', '<script>', '<script src="a">', '</script>', '</script', '</script >', '</ScRiPt foo>', '<SCRIPT >', '<scripts>', '</scripts>',
  '<style>', '<style', '</style>', '</STYLE >', '<styles>', '<!--', '-->', '<!-->', '--', '<br>', '<br/>', '<br', '<BR />',
  '</p>', '</div >', '</h2>', '</tr>', '</li', '<a', '<a href="x">', '</a>', '<b>', '</b', '<i', '>', '<', '</', '<1', '< a',
  'текст', 'Цена 9 000 ₽', ' ', '\n', '\t', 'x', '1 < 2', '3 > 1', '&nbsp;', '<p>', '<div class="q">', 'İ', 'ſcript', '<ſcript>',
  // Обломки, из которых снятие тега собирает новый: `<<a>script>`, `<scr<b>ipt>`.
  '<<', '<</', 'a>', '/a', 'b>', 'script', 'style', 'ipt', '<scr', '</scr', 'ipt>', '<!', '!--', '->',
  '<script_', '<script1>', '<script-x>', '</script_>', '<style2', '$&', '$1', '\r', ' ', '<S', 'CRIPT>', '</STYLE', '<sTyLe\n>', '</style\t>',
];
const SEPARATORS = ['', ' ', '\n'];

/**
 * Одна и та же разметка при каждом прогоне: сторож не должен мигать.
 *
 * Умножение — через `Math.imul`, а берутся старшие биты. Обычное умножение
 * выходило за 2^53 и теряло младшие биты: последовательность зацикливалась
 * через десять тысяч шагов.
 */
function samples(count: number, maxTokens: number): string[] {
  let seed = 20261110;
  const next = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  return Array.from({ length: count }, () => Array.from({ length: next(maxTokens) }, () => TOKENS[next(TOKENS.length)]).join(''));
}

/** Первые расхождения нового разбора с эталоном — пусто, если их нет. */
function mismatches(inputs: string[]): string[] {
  const found: string[] = [];
  for (const s of inputs) {
    if (htmlToText(s) !== refHtmlToText(s)) found.push(`htmlToText: ${JSON.stringify(s)}`);
    for (const sep of SEPARATORS) {
      if (stripTags(s, sep) !== refStripTags(s, sep)) found.push(`stripTags ${JSON.stringify(sep)}: ${JSON.stringify(s)}`);
      if (stripScriptsAndStyles(s, sep) !== refStripScriptsAndStyles(s, sep)) found.push(`stripScriptsAndStyles ${JSON.stringify(sep)}: ${JSON.stringify(s)}`);
    }
    if (found.length >= 3) break;
  }
  return found;
}

describe('текст тот же, что давали прежние регулярки', () => {
  it('на обычной странице', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var price = 999;</script></head>
      <body><h1>Восхождение</h1><p>Цена: 320 000 ₽</p><!-- комментарий --><div>Даты:<br>12.07 — 25.07</div>
      <script >track()</script ><table><tr><td>1 < 2</td></tr><tr><td>3 > 1</td></tr></table></body></html>`;
    expect(mismatches([html])).toEqual([]);
    expect(htmlToText(html)).toContain('Цена: 320 000 ₽');
    expect(htmlToText(html)).not.toContain('track()');
  });

  it('образцы действительно разные: генератор не ходит по кругу', () => {
    expect(new Set(samples(30_000, 14)).size).toBeGreaterThan(20_000);
    expect(new Set(samples(1_500, 80)).size).toBeGreaterThan(1_400);
  });

  it('на тридцати тысячах случайных обломков разметки — ни одного расхождения ни у одной из трёх функций', () => {
    expect(mismatches(samples(30_000, 14))).toEqual([]);
  }, 120_000);

  it('на длинных цепочках обломков, где снятие тега собирает новый', () => {
    expect(mismatches(samples(1_500, 80))).toEqual([]);
  }, 120_000);

  it('на странице, обрезанной посреди тега, скрипта, стиля и комментария', () => {
    const page = '<p>Тур</p><script>var a = "<p>не текст</p>";</script><style>p{}</style><!-- скрыто --><p>Цена 9 000 ₽</p><a href="/x">дальше</a>';
    expect(mismatches(Array.from({ length: page.length + 1 }, (_, cut) => page.slice(0, cut)))).toEqual([]);
  });
});

describe('что снимается вместе с телом', () => {
  it('пары script и style с любым закрывающим тегом', () => {
    expect(stripScriptsAndStyles('a<script>x</script >b<STYLE>y</style foo>c')).toBe('a b c');
    // `<scripts>` — не script: граница слова, как у регулярки.
    expect(stripScriptsAndStyles('<scripts>видно</scripts>')).toBe('<scripts>видно</scripts>');
  });

  it('первый тег без пары — до конца документа', () => {
    expect(stripScriptsAndStyles('до<script>тело <p>не текст</p>')).toBe('до ');
    expect(stripScriptsAndStyles('до<style>тело')).toBe('до ');
    // Закрывающий тег есть, а «>» у него нет — пара не сложилась, тело не текст.
    expect(stripScriptsAndStyles('до<script>тело</script')).toBe('до ');
  });

  it('открывающий тег без «>» — ещё не тег: его снимает правило хвоста у stripTags', () => {
    expect(stripScriptsAndStyles('до<script src="x')).toBe('до<script src="x');
    expect(stripTags('до<script src="x')).toBe('до');
  });

  it('тег, собранный снятием другого, тоже снимается; «меньше» и «больше» — текст', () => {
    expect(stripTags('<<a>script>alert(1)</script>')).toBe(refStripTags('<<a>script>alert(1)</script>'));
    expect(stripTags('<<a>b>текст')).toBe('текст');
    expect(stripTags('1 < 2 и 3 > 1, а дальше < просто знак')).toBe('1 < 2 и 3 > 1, а дальше < просто знак');
  });

  it('витков снятия ровно пять: пятый слой вложения снимается, шестой остаётся', () => {
    expect(MAX_PASSES).toBe(REF_MAX_PASSES);
    expect(stripTags('<<<<<a>a>a>a>a>x')).toBe('x');
    expect(stripTags('<<<<<<a>a>a>a>a>a>x')).toBe('<a>x');
    expect(stripTags('<<<a>b>c>x')).toBe('x');
    expect(htmlToText('<<<<<<a>a>a>a>a>a>x')).toBe(refHtmlToText('<<<<<<a>a>a>a>a>a>x'));
  });

  it('регистр тега не важен; «İ» в странице и знак Кельвина после имени тега ничего не ломают', () => {
    expect(stripScriptsAndStyles('a<ScRiPt>x</sCrIpT >b')).toBe('a b');
    const inputs = [
      'İ<SCRIPT>x</SCRIPT>y', 'İİ<StYlE>q</sTyLe >İ<i', 'a<script\u212a>x</script>b', 'a<script>x</script\u212a>b', '<scr\u0131pt>x',
      // «scrİpt» — не script, хотя рядом стоит настоящий style: тело остаётся текстом.
      'a<scrİpt>x</scrİpt>b<style>y</style>c', '<stİle>видно</stİle><script>нет</script>',
    ];
    for (const html of inputs) expect(mismatches([html]), JSON.stringify(html)).toEqual([]);
    expect(stripScriptsAndStyles('a<scrİpt>x</scrİpt>b<style>y</style>c')).toBe('a<scrİpt>x</scrİpt>b c');
  });

  it('разделитель — обычный текст: «$&» в нём ничего не значит', () => {
    expect(stripTags('a<b>c<script>x</script>d<i', '$&')).toBe('a$&c$&d$&');
    expect(stripScriptsAndStyles('a<script>x</script>b<style>y', '$1')).toBe('a$1b$1');
  });
});

// ── Время ────────────────────────────────────────────────────────────────────

/**
 * Повреждённые страницы размером `n`: на большинстве прежний разбор работал за
 * квадрат, на «<script>, а закрывающие без >» — за куб. Остальные (комментарии,
 * тег, собранный витками, без «>») он проходил за линейное время — они стоят
 * здесь как контроль того, что линейным осталось и новое.
 */
function broken(n: number): Record<string, string> {
  const assembled = '<<<<<<b>b>b>b>b>a ';
  return {
    'одни «<a » без «>»': '<a '.repeat(n / 3),
    'одни «<script>» без закрывающего': '<script>'.repeat(n / 8),
    'одни «<script » без «>»': '<script '.repeat(n / 8),
    '«<script » без «>» и один закрывающий в конце': `${'<script '.repeat(n / 8 - 2)}</script>`,
    'закрывающие, а за ними открывающие': '</script>'.repeat(n / 18) + '<script>'.repeat(n / 16),
    '«<script>», а закрывающие без «>»': '<script>'.repeat(n / 16) + '</script'.repeat(n / 16),
    'одни «<style>»': '<style>'.repeat(n / 7),
    'одни «<style » без «>»': '<style '.repeat(n / 7),
    'одни «<!--»': '<!--'.repeat(n / 4),
    'одни «</a» без «>»': '</a'.repeat(n / 3),
    '«<a» и перевод строки в конце': `${'<a'.repeat(n / 2 - 2)}<br>`,
    '«<a» и комментарий в конце': `${'<a'.repeat(n / 2 - 5)}<!-- x -->`,
    '«<a» и закрытие блока в конце': `${'<a'.repeat(n / 2 - 2)}</p>`,
    '«<a» и открывающий script в конце': `${'<a'.repeat(n / 2 - 4)}<script>`,
    '«<a » по обе стороны от единственного «>»': `${'<a '.repeat(n / 6)}>${'<a '.repeat(n / 6 - 1)}`,
    'тег из обломков: «<<i>a»': '<<i>a'.repeat(n / 5),
    'тег, собранный пятью витками, и «>» в конце': `${assembled.repeat(Math.floor(n / assembled.length) - 1)}>`,
    'тег, собранный пятью витками, без «>»': assembled.repeat(Math.floor(n / assembled.length)),
    '«<br» и пробелы без «>»': `<br${' '.repeat(97)}`.repeat(n / 100),
    '«<scripts » — не script': '<scripts '.repeat(n / 9),
    'чередующийся регистр и «<script» в конце': `${'A '.repeat(n / 2 - 4)}<script`,
    'чередующийся регистр, «İ» и «<style» в конце': `İ${'aB'.repeat(n / 2 - 4)}<style`,
  };
}

const PARSERS: Record<string, (html: string) => string> = {
  htmlToText: (html) => htmlToText(html),
  'stripTags без разделителя': (html) => stripTags(html),
  'stripTags с пробелом': (html) => stripTags(html, ' '),
  stripScriptsAndStyles: (html) => stripScriptsAndStyles(html),
};

function elapsedMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('повреждённая разметка не держит процесс', () => {
  // Два размера подряд. На 20 тыс. знаков куб прежнего разбора — секунды, и
  // проверка краснеет сразу; квадрат на них ещё незаметен и краснит на 300 тыс.
  // (от нескольких секунд на форму). Сразу 300 тыс. нельзя: куб на них — часы,
  // вызов синхронный, и прогон не покраснел бы, а повис.
  const TINY = 20_000;
  const SMALL = 300_000;
  const TINY_LIMIT_MS = 1_000;
  const SMALL_LIMIT_MS = 2_000;
  const names = Object.keys(broken(TINY));
  let small_passed = 0;

  for (const name of names) {
    it(`${name} — 20 тыс. и 300 тыс. знаков`, () => {
      for (const [size, limit] of [[TINY, TINY_LIMIT_MS], [SMALL, SMALL_LIMIT_MS]] as const) {
        const html = broken(size)[name];
        expect(html.length).toBeLessThanOrEqual(size + 1);
        for (const [parser, run] of Object.entries(PARSERS)) {
          expect(elapsedMs(() => run(html)), `${parser}, ${size} знаков`).toBeLessThan(limit);
        }
      }
      small_passed += 1;
    }, 300_000);
  }

  // Потолок наблюдения за сайтами партнёров — 3 млн знаков, вдесятеро больше.
  // Проверяется только после малого размера: на квадрате это были бы часы.
  // Возврат прежней регулярки хвоста виден только здесь, у stripTags на теге,
  // собранном пятью витками: на 300 тыс. он ещё укладывается в предел.
  it('страница на потолке наблюдения (3 млн знаков) — каждая форма меньше пяти секунд', () => {
    expect(small_passed, 'сначала должен пройти малый размер').toBe(names.length);
    for (const [name, html] of Object.entries(broken(WATCH_BODY_LIMIT))) {
      expect(html.length, name).toBeLessThanOrEqual(WATCH_BODY_LIMIT + 1);
      expect(elapsedMs(() => fullPageText(html)), name).toBeLessThan(5_000);
      expect(elapsedMs(() => stripTags(html)), `${name} — stripTags`).toBeLessThan(5_000);
    }
  }, 300_000);

  it('обычная большая страница — быстро и с тем же числом строк', () => {
    const html = `<html><body>${'<div class="card"><p>Начало тура</p><p>от 45 000 руб.</p><script>t()</script></div>'.repeat(20_000)}</body></html>`;
    expect(html.length).toBeLessThanOrEqual(WATCH_BODY_LIMIT);
    let text = '';
    expect(elapsedMs(() => { text = fullPageText(html); })).toBeLessThan(5_000);
    expect(text.split('\n')).toHaveLength(40_000);
  }, 60_000);
});
