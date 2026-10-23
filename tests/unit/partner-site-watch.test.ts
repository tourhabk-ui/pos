/**
 * Наблюдение за сайтами партнёров — правила сравнения вызовом (слово
 * владельца 22.10: «нам нужно проверять сайты партнеров на изменение»).
 * Прогон с базой — tests/integration/partner-site-watch.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  baselineMessage, diffLines, meaningfulDiff, ownerMessage, pageText, robotsDisallows, textHash, watchEvent, WATCH_USER_AGENT,
  type PageReport,
} from '@/lib/partners/site-watch';

describe('видимый текст страницы', () => {
  it('без скриптов, стилей и разметки; строки по блокам; сущности развёрнуты', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var price = 999;</script></head>
      <body><h1>Восхождение на&nbsp;Ключевскую</h1><p>Цена: 320&#160;000 &#8381;</p>
      <script >track()</script ><div>Даты:<br>12.07 — 25.07</div><!-- комментарий --></body></html>`;
    expect(pageText(html)).toBe('Восхождение на Ключевскую\nЦена: 320 000 ₽\nДаты:\n12.07 — 25.07');
  });

  it('смена вёрстки и скриптов — тот же текст, тот же хэш', () => {
    const a = '<div class="x"><p>Тур 5 дней</p></div><script>v=1</script>';
    const b = '<section data-v="2"><p>Тур 5 дней</p></section><script>v=2</script>';
    expect(textHash(pageText(a))).toBe(textHash(pageText(b)));
  });
});

describe('разница текстов', () => {
  it('строки про деньги и даты — впереди, перестановка строк изменением не считается', () => {
    const prev = 'О туре\nЦена: 320 000 ₽\nГид с опытом\nВыезд 12.07';
    const next = 'О туре\nГид с опытом\nЦена: 340 000 ₽\nВыезд 12.07\nНовый пункт программы';
    expect(diffLines(prev, next)).toEqual({ removed: ['Цена: 320 000 ₽'], added: ['Цена: 340 000 ₽', 'Новый пункт программы'] });
    expect(diffLines('a\nb', 'b\na')).toEqual({ removed: [], added: [] });
  });

  it('месяц узнаётся словом, а не куском слова', () => {
    const d = diffLines('', 'Камартан у моря\nВыезд в мае: 3 мая');
    expect(d.added[0]).toBe('Выезд в мае: 3 мая');
  });
});

// Отчёт 23.10: все показанные «изменения» 24 страниц «Местечка Камчатка» —
// цифры капчи формы (Contact Form 7, `wpcf7-quiz`), две формы на странице.
describe('капча формы — не изменение', () => {
  const quiz = (q: string) =>
    `<p>Защита от роботов: <span class="wpcf7-form-control-wrap"><label><span class="wpcf7-quiz-label">${q}</span> <input type="text" /></label></span></p>`;
  const tour = (price: string, q1: string, q2: string) =>
    `<h1>Озеро Толмачёва</h1><p>Цена: ${price} ₽</p>${quiz(q1)}${quiz(q2)}`;

  it('строка «Защита от роботов: 4+4=?» в текст страницы не попадает; цена и даты — остаются', () => {
    expect(pageText(tour('12 000', '4+4=?', '1+1=?'))).toBe('Озеро Толмачёва\nЦена: 12 000 ₽');
    expect(textHash(pageText(tour('12 000', '4+4=?', '1+1=?')))).toBe(textHash(pageText(tour('12 000', '3+3=?', '5+5=?'))));
    expect(pageText('<p>Выезд 12.07, 5 дней</p><p>Скидка 10+2=12%</p>')).toBe('Выезд 12.07, 5 дней\nСкидка 10+2=12%');
  });

  it('снимок, записанный с капчей, против нового текста без неё: разницы нет', () => {
    expect(meaningfulDiff('Озеро\nЦена: 12 000 ₽\nЗащита от роботов: 3+3=?', 'Озеро\nЦена: 12 000 ₽')).toBeNull();
    expect(meaningfulDiff('Защита от роботов: 3+3=?\nЗащита от роботов: 5+5=?', 'Защита от роботов: 2+2=?')).toBeNull();
  });

  it('перестановка и повтор тех же строк — не изменение; смена цены — изменение без капчи в разнице', () => {
    expect(meaningfulDiff('a\nb\nb', 'b\na')).toBeNull();
    expect(meaningfulDiff('Цена: 12 000 ₽\nЗащита от роботов: 3+3=?', 'Цена: 14 000 ₽')).toEqual({
      removed: ['Цена: 12 000 ₽'], added: ['Цена: 14 000 ₽'],
    });
  });
});

describe('robots.txt', () => {
  const ROBOTS = `User-agent: *\nDisallow: /admin\nDisallow: /tours/private\nAllow: /tours/private/open\n\nUser-agent: Googlebot\nDisallow: /`;
  it('группа «*»: запрет по префиксу, Allow длиннее — разрешает', () => {
    expect(robotsDisallows(ROBOTS, '/admin/x')).toBe(true);
    expect(robotsDisallows(ROBOTS, '/tours/private/1')).toBe(true);
    expect(robotsDisallows(ROBOTS, '/tours/private/open/2')).toBe(false);
    expect(robotsDisallows(ROBOTS, '/tours/kluchevskaya/')).toBe(false);
  });
  it('своя группа важнее «*»; чужая (Googlebot) нас не касается', () => {
    expect(robotsDisallows('User-agent: *\nDisallow:\n\nUser-agent: VedarSiteWatch\nDisallow: /', '/x')).toBe(true);
    expect(robotsDisallows('User-agent: Googlebot\nDisallow: /', '/x')).toBe(false);
  });
  it('нет robots.txt или пустой Disallow — ничего не запрещено; * и $ в шаблоне', () => {
    expect(robotsDisallows(null, '/x')).toBe(false);
    expect(robotsDisallows('User-agent: *\nDisallow:', '/x')).toBe(false);
    expect(robotsDisallows('User-agent: *\nDisallow: /*.pdf$', '/files/a.pdf')).toBe(true);
    expect(robotsDisallows('User-agent: *\nDisallow: /*.pdf$', '/files/a.pdf?x=1')).toBe(false);
  });
  it('имя — своё, не браузер и не поисковик', () => {
    expect(WATCH_USER_AGENT).toMatch(/^VedarSiteWatch\//);
    expect(WATCH_USER_AGENT).not.toMatch(/Mozilla|Googlebot|YandexBot|Chrome/);
  });
});

describe('вердикт по истории страницы', () => {
  const ok = (hash: string) => ({ outcome: 'ok' as const, hash });
  const gone = { outcome: 'gone' as const, hash: null };
  const failed = { outcome: 'failed' as const, hash: null };
  it('первое чтение — точка отсчёта; тот же текст — без перемен; другой — изменилась', () => {
    expect(watchEvent(ok('a'), null, null, null).kind).toBe('baseline');
    expect(watchEvent(ok('a'), ok('a'), null, 'a').kind).toBe('same');
    expect(watchEvent(ok('b'), ok('a'), null, 'a').kind).toBe('changed');
  });
  it('404 впервые — «пропала», дальше молчим; вернулась — «снова открывается»', () => {
    expect(watchEvent(gone, ok('a'), null, 'a').kind).toBe('gone');
    expect(watchEvent(gone, gone, ok('a'), 'a').kind).toBe('quiet');
    expect(watchEvent(ok('a'), gone, ok('a'), 'a').kind).toBe('back');
  });
  it('один отказ сети — не тревога; второй подряд — «не открывается»; третий — молчим', () => {
    expect(watchEvent(failed, ok('a'), null, 'a').kind).toBe('quiet');
    expect(watchEvent(failed, failed, ok('a'), 'a').kind).toBe('failing');
    expect(watchEvent(failed, failed, failed, 'a').kind).toBe('quiet');
  });
  it('robots.txt запретил — не изменение', () => {
    expect(watchEvent({ outcome: 'robots', hash: null }, ok('a'), null, 'a').kind).toBe('quiet');
  });
});

describe('сообщение владельцу', () => {
  const page = { url: 'https://volcanoesland.ru/tours/kl/', partnerName: 'Край <Вулканов>', tours: ['Восхождение на Ключевскую'] };
  it('изменение: чей, какой наш тур, было и стало; чужой текст экранирован', () => {
    const r: PageReport = { page, event: 'changed', diff: { removed: ['Цена: 320 000 ₽'], added: ['Цена: <b>340 000</b> ₽'] } };
    const text = ownerMessage([r])!;
    expect(text).toContain('Край &lt;Вулканов&gt;');
    expect(text).toContain('тур «Восхождение на Ключевскую»');
    expect(text).toContain('volcanoesland.ru/tours/kl');
    expect(text).toContain('было: Цена: 320 000 ₽');
    expect(text).toContain('стало: Цена: &lt;b&gt;340 000&lt;/b&gt; ₽');
    expect(text).toContain('Наши карточки этих туров могли устареть');
  });
  it('пропала, вернулась, не открывается — словами; главная сайта — главной', () => {
    const home = { url: 'https://mestechkokam.ru', partnerName: 'Местечко Камчатка', tours: [] };
    const text = ownerMessage([
      { page, event: 'gone', httpStatus: 404 },
      { page: home, event: 'failing', httpStatus: 503 },
      { page, event: 'back' },
    ])!;
    expect(text).toContain('страница пропала с сайта партнёра (404)');
    expect(text).toContain('Местечко Камчатка</b> — главная страница сайта');
    expect(text).toContain('не открывается второй день (HTTP 503)');
    expect(text).toContain('страница снова открывается');
  });
  it('без перемен, точка отсчёта и молчание — сообщения нет', () => {
    expect(ownerMessage([{ page, event: 'same' }, { page, event: 'baseline' }, { page, event: 'quiet' }])).toBeNull();
  });
  it('длинный список не выходит за предел Telegram — остаток назван числом', () => {
    const many: PageReport[] = Array.from({ length: 80 }, (_, i) => ({
      page: { ...page, url: `https://volcanoesland.ru/tours/${i}/` },
      event: 'changed', diff: { removed: ['x'.repeat(200)], added: ['y'.repeat(200)] },
    }));
    const text = ownerMessage(many)!;
    expect(text.length).toBeLessThan(4096);
    expect(text).toMatch(/ещё изменений: \d+/);
  });
  it('сайт, который ведём мы: пометка у имени, сверка в обратную сторону', () => {
    const ours = { url: 'https://fishingkam.ru', partnerName: 'Камчатская рыбалка', tours: [], managedByUs: true };
    const only = ownerMessage([{ page: ours, event: 'changed', diff: { removed: ['Цена 20 000'], added: ['Цена 22 000'] } }])!;
    expect(only).toContain('Камчатская рыбалка</b> (сайт ведём мы) — главная страница сайта');
    expect(only).toContain('если правка не наша — проверьте, у кого есть доступ');
    expect(only).not.toContain('Наши карточки этих туров могли устареть');
    const mixed = ownerMessage([
      { page: ours, event: 'changed', diff: { removed: ['a'], added: ['b'] } },
      { page, event: 'gone', httpStatus: 404 },
    ])!;
    expect(mixed).toContain('Наши карточки этих туров могли устареть');
    expect(mixed).toContain('правим мы сами');
    expect(mixed).not.toContain('Край &lt;Вулканов&gt;</b> (сайт ведём мы)');
    expect(baselineMessage([ours, page])).toContain('Камчатская рыбалка — страниц: 1 · сайт ведём мы');
    expect(baselineMessage([ours, page])).toContain('Край &lt;Вулканов&gt; — страниц: 1\n');
  });

  it('первый прогон: кого взяли под наблюдение, по партнёрам', () => {
    const text = baselineMessage([
      page, { ...page, url: 'https://volcanoesland.ru' }, { url: 'https://fishingkam.ru', partnerName: 'Камчатская рыбалка', tours: [] },
    ])!;
    expect(text).toContain('Край &lt;Вулканов&gt; — страниц: 2');
    expect(text).toContain('Камчатская рыбалка — страниц: 1');
    expect(baselineMessage([])).toBeNull();
  });
});
