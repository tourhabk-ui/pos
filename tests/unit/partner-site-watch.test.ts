/**
 * Наблюдение за сайтами партнёров — правила сравнения вызовом (слово
 * владельца 22.10: «нам нужно проверять сайты партнеров на изменение»).
 * Прогон с базой — tests/integration/partner-site-watch.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  baselineMessage, diffLines, meaningfulDiff, ownerMessages, pageText, robotsDisallows, textHash, watchEvent, WATCH_USER_AGENT,
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
    const messages = ownerMessages([r]);
    expect(messages).toHaveLength(1);
    const text = messages[0]!;
    expect(text).toContain('Край &lt;Вулканов&gt;');
    expect(text).toContain('тур «Восхождение на Ключевскую»');
    expect(text).toContain('volcanoesland.ru/tours/kl');
    expect(text).toContain('было: Цена: 320 000 ₽');
    expect(text).toContain('стало: Цена: &lt;b&gt;340 000&lt;/b&gt; ₽');
    expect(text).toContain('Наши карточки этих туров могли устареть');
  });
  it('пропала, вернулась, не открывается — словами; главная сайта — главной', () => {
    const home = { url: 'https://mestechkokam.ru', partnerName: 'Местечко Камчатка', tours: [] };
    const [text] = ownerMessages([
      { page, event: 'gone', httpStatus: 404 },
      { page: home, event: 'failing', httpStatus: 503 },
      { page, event: 'back' },
    ]);
    expect(text).toContain('страница пропала с сайта партнёра (404)');
    expect(text).toContain('Местечко Камчатка</b> — главная страница сайта');
    expect(text).toContain('не открывается второй день (HTTP 503)');
    expect(text).toContain('страница снова открывается');
  });
  it('без перемен, точка отсчёта и молчание — сообщения нет', () => {
    expect(ownerMessages([{ page, event: 'same' }, { page, event: 'baseline' }, { page, event: 'quiet' }])).toEqual([]);
  });
  // Отчёт 08.11 кончался «ещё изменений: 14 — полностью в partner_page_snapshots»:
  // таблицу базы владелец не читает, и эти 14 он не увидел вовсе.
  const changedPages = (n: number): PageReport[] => Array.from({ length: n }, (_, i) => ({
    page: { ...page, url: `https://volcanoesland.ru/tours/${i}/` },
    event: 'changed', diff: { removed: ['x'.repeat(200)], added: ['y'.repeat(200)] },
  }));
  it('не влезло в одно сообщение — остаток приходит следующими, каждое в пределе Telegram, ничего не потеряно', () => {
    const messages = ownerMessages(changedPages(12));
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThan(4096);
    expect(messages[0]).toMatch(/^<b>Сайты партнёров: изменений — 12<\/b>/);
    for (const m of messages.slice(1)) expect(m).toMatch(/^<b>Сайты партнёров — продолжение<\/b>/);
    const all = messages.join('\n');
    for (let i = 0; i < 12; i++) expect(all.split(`volcanoesland.ru/tours/${i}\n`)).toHaveLength(2);
    // Что делать — в конце, один раз; таблицы базы в тексте нет.
    expect(messages.at(-1)).toContain('Наши карточки этих туров могли устареть');
    expect(all.split('Наши карточки этих туров могли устареть')).toHaveLength(2);
    expect(all).not.toContain('partner_page_snapshots');
    expect(all).not.toMatch(/ещё изменений/);
  });
  it('очень длинный список — не больше пяти сообщений, остаток назван числом', () => {
    const messages = ownerMessages(changedPages(80));
    expect(messages).toHaveLength(5);
    for (const m of messages) expect(m.length).toBeLessThan(4096);
    const shown = messages.join('\n').split('volcanoesland.ru/tours/').length - 1;
    expect(messages.at(-1)).toContain(`ещё изменений: ${80 - shown} — не вошли в 5 сообщений`);
    expect(messages.at(-1)).toContain('Наши карточки этих туров могли устареть');
    expect(messages.join('\n')).not.toContain('partner_page_snapshots');
  });
  it('сайт, который ведём мы: пометка у имени, сверка в обратную сторону', () => {
    const ours = { url: 'https://fishingkam.ru', partnerName: 'Камчатская рыбалка', tours: [], managedByUs: true };
    const [only] = ownerMessages([{ page: ours, event: 'changed', diff: { removed: ['Цена 20 000'], added: ['Цена 22 000'] } }]);
    expect(only).toContain('Камчатская рыбалка</b> (сайт ведём мы) — главная страница сайта');
    expect(only).toContain('если правка не наша — проверьте, у кого есть доступ');
    expect(only).not.toContain('Наши карточки этих туров могли устареть');
    const [mixed] = ownerMessages([
      { page: ours, event: 'changed', diff: { removed: ['a'], added: ['b'] } },
      { page, event: 'gone', httpStatus: 404 },
    ]);
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

describe('скользящие даты (03.11, laguna-expedition.ru)', () => {
  it('сдвиг ближайшей даты на день вперёд — не изменение', () => {
    expect(meaningfulDiff('Тур\nБлижайший выезд: 4 ноября\nЦена 5 000 ₽', 'Тур\nБлижайший выезд: 5 ноября\nЦена 5 000 ₽')).toBeNull();
    expect(meaningfulDiff('Ближайшая дата 03.11.2026', 'Ближайшая дата 04.11.2026')).toBeNull();
    expect(meaningfulDiff('Старт 31 декабря', 'Старт 2 января')).toBeNull();
  });
  it('дата назад, дальний перенос или другой текст — изменение', () => {
    expect(meaningfulDiff('Выезд: 5 ноября', 'Выезд: 4 ноября')).not.toBeNull();
    expect(meaningfulDiff('Выезд: 4 ноября', 'Выезд: 4 декабря')).not.toBeNull();
    expect(meaningfulDiff('Выезд 4 ноября, 5 000 ₽', 'Выезд 5 ноября, 6 000 ₽')).not.toBeNull();
    expect(meaningfulDiff('Цена 5 000 ₽', 'Цена 6 000 ₽')).not.toBeNull();
  });
  it('настоящая смена рядом со сдвигом остаётся в разнице', () => {
    const d = meaningfulDiff('Ближайший 4 ноября\nЦена 5 000 ₽', 'Ближайший 5 ноября\nЦена 6 000 ₽');
    expect(d).toEqual({ removed: ['Цена 5 000 ₽'], added: ['Цена 6 000 ₽'] });
  });
});

// Отчёт 08.11 о «Лагуне»: 29 «изменений», почти все — выезд, день которого
// наступил («было: 08 ноября 2026,» и «было: 08 ноября 2026»), и счётчик мест.
// Текст — как pageText страницы тура laguna-expedition.ru: начало и конец
// выезда отдельными строками.
describe('прошедший выезд и счётчик мест — не изменение (08.11, laguna-expedition.ru)', () => {
  const TODAY = '2026-11-08';
  const departure = (weekday: string, date: string, time: string, seats: string) => [
    'Начало тура', `${weekday},`, `${date},`, time, 'Окончание тура', `${weekday},`, date, 'от 9 000 руб.', 'Забронировать', seats,
  ];
  const tourPage = (...deps: string[][]) => ['Конная прогулка', 'Ноябрь 2026', ...deps.flat(), 'Смотреть другие туры'].join('\n');
  const d07 = departure('Суббота', '07 ноября 2026', 'в 09:00', 'Осталось 8 мест');
  const d08 = departure('Воскресенье', '08 ноября 2026', 'в 10:00', 'Осталось 4 места');
  const d09 = departure('Понедельник', '09 ноября 2026', 'в 09:00', 'Осталось 8 мест');
  const d10 = departure('Вторник', '10 ноября 2026', 'в 09:00', 'Осталось 8 мест');

  it('выезд сегодняшнего дня ушёл с календаря вместе со своим временем и днём недели — тишина', () => {
    expect(meaningfulDiff(tourPage(d08, d09, d10), tourPage(d09, d10), TODAY)).toBeNull();
  });

  it('вчерашний выезд — тоже; без сегодняшней даты правило не применяется', () => {
    expect(meaningfulDiff(tourPage(d07, d09), tourPage(d09), TODAY)).toBeNull();
    expect(meaningfulDiff(tourPage(d07, d09), tourPage(d09))).toEqual({
      removed: ['07 ноября 2026,', '07 ноября 2026', 'Суббота,'], added: [],
    });
  });

  it('счётчик мест сменился, появился или пропал — тишина; цена сменилась — изменение', () => {
    const booked = departure('Понедельник', '09 ноября 2026', 'в 09:00', 'Осталось 3 места');
    expect(meaningfulDiff(tourPage(d09, d10), tourPage(booked, d10), TODAY)).toBeNull();
    expect(meaningfulDiff(tourPage(d09), tourPage(d09.slice(0, -1)), TODAY)).toBeNull();
    const pricier = d09.map((l) => (l === 'от 9 000 руб.' ? 'от 9 500 руб.' : l));
    expect(meaningfulDiff(tourPage(d09), tourPage(pricier), TODAY)).toEqual({ removed: ['от 9 000 руб.'], added: ['от 9 500 руб.'] });
  });

  it('снятый БУДУЩИЙ выезд — изменение: это отменённая дата', () => {
    expect(meaningfulDiff(tourPage(d09, d10), tourPage(d09), TODAY)).toEqual({
      removed: ['10 ноября 2026,', '10 ноября 2026', 'Вторник,'], added: [],
    });
  });

  it('рядом с прошедшим выездом: снятая будущая дата и смена времени видны', () => {
    // 08-е ушло само, 10-е снято партнёром.
    expect(meaningfulDiff(tourPage(d08, d09, d10), tourPage(d09), TODAY)).toEqual({
      removed: ['10 ноября 2026,', '10 ноября 2026'], added: [],
    });
    // 08-е ушло, а 09-е перенесли с 09:00 на 11:00: новое время появилось — и
    // ушедшие времена показаны все, включая 10:00 прошедшего выезда: какое из
    // них ушло с ним, правило не угадывает.
    const d09late = departure('Понедельник', '09 ноября 2026', 'в 11:00', 'Осталось 8 мест');
    expect(meaningfulDiff(tourPage(d08, d09), tourPage(d09late), TODAY)).toEqual({ removed: ['в 10:00', 'в 09:00'], added: ['в 11:00'] });
  });

  it('заголовок месяца ушёл с последним выездом месяца — тишина; будущий месяц пропал — изменение', () => {
    const d30 = departure('Понедельник', '30 ноября 2026', 'в 09:00', 'Осталось 8 мест');
    const dec01 = departure('Вторник', '01 декабря 2026', 'в 09:00', 'Осталось 8 мест');
    const twoMonths = ['Тур', 'Ноябрь 2026', ...d30, 'Декабрь 2026', ...dec01].join('\n');
    const decOnly = ['Тур', 'Декабрь 2026', ...dec01].join('\n');
    expect(meaningfulDiff(twoMonths, decOnly, '2026-11-30')).toBeNull();
    expect(meaningfulDiff(twoMonths, ['Тур', 'Ноябрь 2026', ...d30].join('\n'), '2026-11-08')).toEqual({
      removed: ['Декабрь 2026', '01 декабря 2026,', '01 декабря 2026', 'Вторник,'], added: [],
    });
  });

  it('в один день ушёл последний выезд месяца и снят выезд следующего: следующий месяц и снятая дата видны', () => {
    const d30 = departure('Понедельник', '30 ноября 2026', 'в 09:00', 'Осталось 8 мест');
    const dec01 = departure('Вторник', '01 декабря 2026', 'в 09:00', 'Осталось 8 мест');
    const dec02 = departure('Среда', '02 декабря 2026', 'в 09:00', 'Осталось 8 мест');
    const before = ['Тур', 'Ноябрь 2026', ...d30, 'Декабрь 2026', ...dec01, ...dec02].join('\n');
    const after = ['Тур', ...dec02].join('\n');
    expect(meaningfulDiff(before, after, '2026-11-30')).toEqual({
      removed: ['Декабрь 2026', '01 декабря 2026,', '01 декабря 2026'], added: [],
    });
  });

  it('дата без года прошедшей не считается; дата с текстом вокруг — тоже', () => {
    expect(meaningfulDiff('Выезды\n4 ноября\nЦена 5 000 ₽', 'Выезды\nЦена 5 000 ₽', TODAY)).toEqual({ removed: ['4 ноября'], added: [] });
    expect(meaningfulDiff('Тур\nВыезд 07 ноября 2026, сбор у отеля', 'Тур', TODAY)).toEqual({
      removed: ['Выезд 07 ноября 2026, сбор у отеля'], added: [],
    });
    expect(meaningfulDiff('Тур\n07.11.2026', 'Тур', TODAY)).toBeNull();
  });
});
