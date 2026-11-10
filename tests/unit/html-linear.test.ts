/**
 * Текст чужой страницы за линейное время (lib/html/linear.ts).
 *
 * Находка проверки 10.11: регулярки `htmlToText` на повреждённой странице
 * работают за квадрат — 400 тыс. знаков из одних `<a` разбирались 27 секунд.
 * Разбор синхронный, сервер прода — один процесс: пока он занят, не отвечает
 * ничего, включая SOS. Наблюдение за сайтами партнёров читает страницы до
 * 3 млн знаков по адресу, который партнёр вписал сам.
 *
 * Держит две вещи разом:
 *  - текст тот же, что у `htmlToText`, — иначе у всех страниц под наблюдением
 *    разом сменился бы хэш; сверка — на случайной разметке из обломков тегов;
 *  - повреждённая страница на потолке размера разбирается за доли секунды.
 */
import { describe, it, expect } from 'vitest';
import { htmlToText } from '@/lib/html/text';
import { htmlToTextLinear, tameHtml } from '@/lib/html/linear';
import { fullPageText, WATCH_BODY_LIMIT } from '@/lib/partners/site-watch';

const TOKENS = [
  '<script', '<script>', '<script src="a">', '</script>', '</script', '</script >', '</ScRiPt foo>', '<SCRIPT >', '<scripts>', '</scripts>',
  '<style>', '<style', '</style>', '</STYLE >', '<styles>', '<!--', '-->', '<!-->', '--', '<br>', '<br/>', '<br', '<BR />',
  '</p>', '</div >', '</h2>', '</tr>', '</li', '<a', '<a href="x">', '</a>', '<b>', '</b', '<i', '>', '<', '</', '<1', '< a',
  'текст', 'Цена 9 000 ₽', ' ', '\n', '\t', 'x', '1 < 2', '3 > 1', '&nbsp;', '<p>', '<div class="q">', 'İ', 'ſcript', '<ſcript>',
];

/** Случайная разметка — одна и та же при каждом прогоне: сторож не должен мигать. */
function samples(count: number, maxTokens: number): string[] {
  let seed = 20261110;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  return Array.from({ length: count }, () => Array.from({ length: next(maxTokens) }, () => TOKENS[next(TOKENS.length)]).join(''));
}

describe('текст тот же, что у htmlToText', () => {
  it('на обычной странице', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var price = 999;</script></head>
      <body><h1>Восхождение</h1><p>Цена: 320 000 ₽</p><!-- комментарий --><div>Даты:<br>12.07 — 25.07</div>
      <script >track()</script ><table><tr><td>1 < 2</td></tr><tr><td>3 > 1</td></tr></table></body></html>`;
    expect(htmlToTextLinear(html)).toBe(htmlToText(html));
    expect(htmlToTextLinear(html)).toContain('Цена: 320 000 ₽');
    expect(htmlToTextLinear(html)).not.toContain('track()');
  });

  it('на тридцати тысячах случайных обломков разметки — ни одного расхождения', () => {
    const differ = samples(30_000, 14).filter((s) => htmlToTextLinear(s) !== htmlToText(s));
    expect(differ.slice(0, 3)).toEqual([]);
  }, 60_000);

  it('на странице, обрезанной посреди тега, скрипта, стиля и комментария', () => {
    const page = '<p>Тур</p><script>var a = "<p>не текст</p>";</script><style>p{}</style><!-- скрыто --><p>Цена 9 000 ₽</p><a href="/x">дальше</a>';
    for (let cut = 0; cut <= page.length; cut++) {
      expect(htmlToTextLinear(page.slice(0, cut)), `обрезка на ${cut}`).toBe(htmlToText(page.slice(0, cut)));
    }
  });
});

describe('что убрано из разметки заранее', () => {
  it('пары script и style с любым закрывающим тегом; первый без пары — до конца документа', () => {
    expect(tameHtml('a<script>x</script >b<STYLE>y</style foo>c')).toBe('a b c');
    expect(tameHtml('до<script>тело <p>не текст</p>')).toBe('до ');
    expect(tameHtml('до<style>тело')).toBe('до ');
    // Закрывающий тег есть, а «>» у него нет — пара не сложилась, тело не текст.
    expect(tameHtml('до<script>тело</script')).toBe('до ');
    // `<scripts>` — не script: граница слова, как у регулярки.
    expect(tameHtml('<scripts>видно</scripts>')).toBe('<scripts>видно</scripts>');
  });

  it('комментарии; незакрытый — до конца; хвост без «>» — незакрытый тег', () => {
    expect(tameHtml('a<!-- x -->b<!-- y')).toBe('a b ');
    expect(tameHtml('<p>текст</p> и ещё <a href="x')).toBe('<p>текст\n и ещё  ');
    expect(tameHtml('1 < 2 и 3 > 1, а дальше < просто знак')).toBe('1 < 2 и 3 > 1, а дальше < просто знак');
  });
});

// Каждая страница — на потолке наблюдения. Квадратичный разбор тут — минуты.
describe('повреждённая страница на потолке размера не держит процесс', () => {
  const N = WATCH_BODY_LIMIT;
  const BROKEN: Record<string, string> = {
    'одни «<a» без «>»': '<a'.repeat(N / 2),
    'одни «<script>» без закрывающего': '<script>'.repeat(N / 8),
    '«<script » без «>» и один закрывающий в конце': `${'<script '.repeat(N / 8 - 2)}</script>`,
    'закрывающие, а за ними открывающие': '</script>'.repeat(N / 18) + '<script>'.repeat(N / 16),
    '«<a» и перевод строки в конце': `${'<a'.repeat(N / 2 - 2)}<br>`,
    '«<a» и комментарий в конце': `${'<a'.repeat(N / 2 - 5)}<!-- x -->`,
    'одни «<style>»': '<style>'.repeat(N / 7),
    'одни «<!--»': '<!--'.repeat(N / 4),
    '«<a» и закрытие блока в конце': `${'<a'.repeat(N / 2 - 2)}</p>`,
    '«<a» и открывающий script в конце': `${'<a'.repeat(N / 2 - 4)}<script>`,
    'тег из обломков: «<<i>a»': '<<i>a'.repeat(N / 5),
  };
  for (const [name, html] of Object.entries(BROKEN)) {
    it(name, () => {
      expect(html.length).toBeLessThanOrEqual(N);
      const started = performance.now();
      const text = fullPageText(html);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(typeof text).toBe('string');
    }, 60_000);
  }

  it('обычная большая страница — быстро и с тем же текстом', () => {
    const html = `<html><body>${'<div class="card"><p>Начало тура</p><p>от 45 000 руб.</p><script>t()</script></div>'.repeat(20_000)}</body></html>`;
    expect(html.length).toBeLessThanOrEqual(N);
    const started = performance.now();
    const text = fullPageText(html);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(text.split('\n')).toHaveLength(40_000);
  }, 60_000);
});
