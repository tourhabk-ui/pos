/**
 * Наблюдение за сайтами партнёров — правила сравнения вызовом (слово
 * владельца 22.10: «нам нужно проверять сайты партнеров на изменение»).
 * Прогон с базой — tests/integration/partner-site-watch.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  baselineMessage, cutSnapshotDiff, diffLines, fullPageText, isVolatileLine, legacyReadWasCut, meaningfulDiff, ownerMessages,
  robotsDisallows, textHash, watchEvent, withoutRollingShifts, LEGACY_BODY_LIMIT, LEGACY_TEXT_CAP, ROLLING_MAX_DAYS,
  SITE_WIDE_MIN_PAGES, TEXT_CAP, WATCH_BODY_LIMIT, WATCH_USER_AGENT,
  type PageReport,
} from '@/lib/partners/site-watch';

describe('видимый текст страницы', () => {
  it('без скриптов, стилей и разметки; строки по блокам; сущности развёрнуты', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var price = 999;</script></head>
      <body><h1>Восхождение на&nbsp;Ключевскую</h1><p>Цена: 320&#160;000 &#8381;</p>
      <script >track()</script ><div>Даты:<br>12.07 — 25.07</div><!-- комментарий --></body></html>`;
    expect(fullPageText(html)).toBe('Восхождение на Ключевскую\nЦена: 320 000 ₽\nДаты:\n12.07 — 25.07');
  });

  it('смена вёрстки и скриптов — тот же текст, тот же хэш', () => {
    const a = '<div class="x"><p>Тур 5 дней</p></div><script>v=1</script>';
    const b = '<section data-v="2"><p>Тур 5 дней</p></section><script>v=2</script>';
    expect(textHash(fullPageText(a))).toBe(textHash(fullPageText(b)));
  });
});

// Отчёт 10.11: страницы туров laguna-expedition.ru выросли до 741 тыс. знаков
// при потолке тела 600 тыс.; хвост обрезанной страницы ушёл владельцу
// «пропавшими» строками. Что прогон делает со страницей больше потолка —
// tests/integration/partner-site-watch.pg.test.ts, «прогон 7».
describe('потолки чтения', () => {
  it('страница «Лагуны» с календарём на год умещается с запасом: 756 тыс. знаков тела, 48 тыс. текста', () => {
    expect(WATCH_BODY_LIMIT).toBeGreaterThanOrEqual(3 * 755_960);
    expect(TEXT_CAP).toBeGreaterThanOrEqual(3 * 47_516);
  });

  it('старое чтение обрезало страницу больше 600 тыс. знаков тела или 60 тыс. текста — и только её', () => {
    expect(legacyReadWasCut(LEGACY_BODY_LIMIT, LEGACY_TEXT_CAP)).toBe(false);
    expect(legacyReadWasCut(LEGACY_BODY_LIMIT + 1, 100)).toBe(true);
    expect(legacyReadWasCut(100, LEGACY_TEXT_CAP + 1)).toBe(true);
    // Замеры 10.11: «Вулканы Камчатки (4 дня)» и «Термальный маршрут» (тело на 50 знаков больше потолка).
    expect(legacyReadWasCut(755_960, 47_516)).toBe(true);
    expect(legacyReadWasCut(600_050, 39_952)).toBe(true);
    expect(legacyReadWasCut(300_000, 20_000)).toBe(false);
  });
});

// Находка проверки 10.11: первое полное чтение после выката приходится на день
// акции «11.11» у «Лагуны». Слепая «точка отсчёта» проглотила бы смену цены.
describe('снимок старого, обрезанного чтения против полной страницы', () => {
  const head = ['Вулканы Камчатки', 'от 45 000 руб. за человека', 'Ноябрь 2026'];
  const dep = (start: string, end: string, price = 'от 45 000 руб.') => ['Начало тура', `${start},`, 'в 09:00', 'Окончание тура', end, price, 'Забронировать'];
  const tail = ['Проживание в спа-отеле «Лагуна» (3 ночи)', 'Номер реестровой записи: 000', 'Общая продолжительность экскурсионного дня: 9 – 10 часов'];
  const d1 = dep('20 ноября 2026', '23 ноября 2026');
  const d2 = dep('21 ноября 2026', '24 ноября 2026');
  const d3 = dep('22 ноября 2026', '25 ноября 2026');
  // Старое чтение оборвалось посреди третьего выезда.
  const cutSnapshot = [...head, ...d1, ...d2, 'Начало тура', '22 ноября 2026,', 'в 09'].join('\n');
  const full = (...lines: string[][]) => [...lines.flat(), ...tail].join('\n');

  it('страница та же: хвост, которого в снимке не было, — не новость', () => {
    expect(cutSnapshotDiff(cutSnapshot, full(head, d1, d2, d3), '2026-11-11')).toBeNull();
    // Обычное сравнение на том же входе назвало бы хвост «появившимся».
    expect(meaningfulDiff(cutSnapshot, full(head, d1, d2, d3), '2026-11-11')?.added).toEqual(expect.arrayContaining(tail));
  });

  it('цена сменилась там, куда старое чтение доставало, — видно и «было», и «стало»', () => {
    const cheaper = (lines: string[]) => lines.map((l) => l.replace('45 000', '40 500'));
    expect(cutSnapshotDiff(cutSnapshot, full(cheaper(head), cheaper(d1), cheaper(d2), cheaper(d3)), '2026-11-11')).toEqual({
      removed: ['от 45 000 руб. за человека', 'от 45 000 руб.'], added: ['от 40 500 руб. за человека', 'от 40 500 руб.'],
    });
  });

  it('строка, появившаяся ниже границы снимка, не судится; выше — судится', () => {
    const promo = ['Акция «11.11»: скидка 10% на многодневные туры'];
    expect(cutSnapshotDiff(cutSnapshot, full(head, promo, d1, d2, d3), '2026-11-11')).toEqual({ removed: [], added: promo });
    expect(cutSnapshotDiff(cutSnapshot, [...head, ...d1, ...d2, ...d3, ...promo, ...tail].join('\n'), '2026-11-11')).toBeNull();
  });

  it('граница — последняя строка снимка, единственная на странице, а не первая попавшаяся', () => {
    // Снимок кончается расхожими строками («Начало тура» стоит в каждой карточке):
    // границей служит дата последней целой карточки, и анонс между карточками виден.
    const snapshot = [...head, ...d1, ...d2, 'Начало тура', 'обры'].join('\n');
    const promo = ['Акция «11.11»: скидка 10% на многодневные туры'];
    expect(cutSnapshotDiff(snapshot, full(head, d1, promo, d2, d3), '2026-11-11')).toEqual({ removed: [], added: promo });
  });

  it('обрывок последней строки снимка не считается пропавшим; настоящая пропажа — считается', () => {
    // «в 09» — обрывок «в 09:00»: такой строки на странице нет, но это след обрезки.
    expect(cutSnapshotDiff(cutSnapshot, full(head, d1, d2, d3), '2026-11-11')).toBeNull();
    expect(cutSnapshotDiff(cutSnapshot, full(head, d1, d3), '2026-11-11')).toEqual({ removed: ['21 ноября 2026,', '24 ноября 2026'], added: [] });
  });

  it('в снимке нет ни одной строки, единственной на новой странице: «стало» не судится вовсе, «было» — судится', () => {
    const generic = ['Забронировать', 'Забронировать', 'от 45 000 руб.', 'от 45 000 руб.', 'Забр'].join('\n');
    const next = ['Забронировать', 'Забронировать', 'от 40 500 руб.', 'от 40 500 руб.', 'Новый блок'].join('\n');
    expect(cutSnapshotDiff(generic, next)).toEqual({ removed: ['от 45 000 руб.'], added: [] });
  });
});

// Отчёт 10.11: четыре страницы «Местечка Камчатка» названы изменившимися,
// а на них появился только баннер согласия на cookie.
describe('баннер cookie — не изменение (10.11, mestechkokam.ru)', () => {
  const TOUR = 'Авачинский перевал\nЦена: 9 000 ₽\nВыезд в 09:00';
  const BANNER = 'Используя этот сайт, вы соглашаетесь с тем, что мы используем файлы cookie для его работы.\nПринимаю';

  it('баннер появился или пропал — тишина', () => {
    expect(meaningfulDiff(TOUR, `${TOUR}\n${BANNER}`)).toBeNull();
    expect(meaningfulDiff(`${TOUR}\n${BANNER}`, TOUR)).toBeNull();
  });

  it('баннер сменил слова и кнопки — тишина; «куки» по-русски — тоже баннер', () => {
    const other = 'Мы используем куки, чтобы сайт работал.\nПринять всё\nОтклонить всё\nСохранить';
    expect(meaningfulDiff(`${TOUR}\n${BANNER}`, `${TOUR}\n${other}`)).toBeNull();
    expect(meaningfulDiff(TOUR, `${TOUR}\nПолитика использования файлов Cookie\nOK`)).toBeNull();
  });

  it('рядом с баннером сменилась цена — видна она, а не баннер', () => {
    expect(meaningfulDiff(TOUR, `${TOUR.replace('9 000', '9 500')}\n${BANNER}`)).toEqual({
      removed: ['Цена: 9 000 ₽'], added: ['Цена: 9 500 ₽'],
    });
  });

  it('без баннера кнопка — часть страницы: пропала «Принять» у формы — изменение', () => {
    expect(meaningfulDiff(`${TOUR}\nПринять`, TOUR)).toEqual({ removed: ['Принять'], added: [] });
    expect(meaningfulDiff(TOUR, `${TOUR}\nСохранить`)).toEqual({ removed: [], added: ['Сохранить'] });
  });

  it('цена слиплась с баннером в одну строку — смена цены видна', () => {
    const glued = (price: string) => `Тур\nЦена: ${price} ₽ Забронировать Используя этот сайт, вы соглашаетесь с cookie. Принимаю`;
    expect(meaningfulDiff(glued('9 000'), glued('9 500'))).toEqual({
      removed: ['Цена: 9 000 ₽ Забронировать Используя этот сайт, вы соглашаетесь с cookie. Принимаю'],
      added: ['Цена: 9 500 ₽ Забронировать Используя этот сайт, вы соглашаетесь с cookie. Принимаю'],
    });
    // Строка с ценой баннером не считается и кнопки рядом не выключает.
    expect(meaningfulDiff('Тур\nЦена 9 000 ₽, сайт использует cookie\nПринять', 'Тур\nЦена 9 000 ₽, сайт использует cookie')).toEqual({
      removed: ['Принять'], added: [],
    });
  });

  // Баннер «Лагуны», как его видит сторож: между строками со словом cookie — его же строки без этого слова.
  const LAGUNA_BANNER = [
    'Политика использования файлов Cookie', 'Оставьте заявку на консультацию', 'Отправить',
    'Мы используем файлы cookie и аналогичные технологии для улучшения работы сайта.', 'Прочтите нашу Политику конфиденциальности .',
    'Принять', 'Отклонить', 'Управление Cookies', 'Настройки Cookies', 'Этот веб-сайт использует файлы cookie и аналогичные технологии.',
    'Подробнее в нашей Политике конфиденциальности .', 'Обязательные', 'Обязательные файлы cookie необходимы для работы сайта.',
    'Принять всё', 'Отклонить всё', 'Сохранить',
  ];

  it('баннер «Лагуны» убран, переписан или сменил кнопки — тишина', () => {
    const page = (...banner: string[]) => [TOUR, ...banner].join('\n');
    expect(meaningfulDiff(page(...LAGUNA_BANNER), page())).toBeNull();
    expect(meaningfulDiff(page(), page(...LAGUNA_BANNER))).toBeNull();
    const rewritten = LAGUNA_BANNER.map((l) => ({
      Обязательные: 'Необходимые', Принять: 'Согласиться', Отклонить: 'Только необходимые', 'Принять всё': 'Разрешить все',
      'Отклонить всё': 'Закрыть', Сохранить: 'Сохранить настройки',
    } as Record<string, string>)[l] ?? l);
    expect(meaningfulDiff(page(...LAGUNA_BANNER), page(...rewritten))).toBeNull();
  });

  it('между строками баннера не дальше трёх строк — его же строки; дальше или с ценой — страница', () => {
    const wrap = (...inside: string[]) => ['Тур', 'Мы используем cookie', ...inside, 'Настройки cookie'].join('\n');
    expect(meaningfulDiff(wrap('А', 'Б', 'В'), wrap('Г', 'Д', 'Е'))).toBeNull();
    expect(meaningfulDiff(wrap('А', 'Б', 'В', 'Г'), wrap('А', 'Б', 'В', 'Д'))).toEqual({ removed: ['Г'], added: ['Д'] });
    expect(meaningfulDiff(wrap('Цена 9 000 ₽'), wrap('Цена 9 500 ₽'))).toEqual({ removed: ['Цена 9 000 ₽'], added: ['Цена 9 500 ₽'] });
  });

  it('слово с «кук» внутри баннером не считается; строка длиннее кнопки — не кнопка', () => {
    expect(meaningfulDiff(TOUR, `${TOUR}\nКукуруза на костре`)).toEqual({ removed: [], added: ['Кукуруза на костре'] });
    expect(meaningfulDiff(`${TOUR}\n${BANNER}`, `${TOUR}\n${BANNER}\nПринять участие в туре`)).toEqual({
      removed: [], added: ['Принять участие в туре'],
    });
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
    expect(fullPageText(tour('12 000', '4+4=?', '1+1=?'))).toBe('Озеро Толмачёва\nЦена: 12 000 ₽');
    expect(textHash(fullPageText(tour('12 000', '4+4=?', '1+1=?')))).toBe(textHash(fullPageText(tour('12 000', '3+3=?', '5+5=?'))));
    expect(fullPageText('<p>Выезд 12.07, 5 дней</p><p>Скидка 10+2=12%</p>')).toBe('Выезд 12.07, 5 дней\nСкидка 10+2=12%');
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
  it('страница больше потолка чтения второй день — сказано, что не читается целиком, а не «не открывается»', () => {
    const [text] = ownerMessages([{ page, event: 'failing', httpStatus: 200, tooBig: true }]);
    expect(text).toContain('страница второй день не прочитана; сегодня она больше потолка чтения');
    expect(text).toContain('изменения на ней не видны');
    expect(text).not.toContain('не открывается');
    expect(text).not.toContain('HTTP 200');
    const [net] = ownerMessages([{ page, event: 'failing', httpStatus: 503, tooBig: false }]);
    expect(net).toContain('не открывается второй день (HTTP 503)');
  });

  it('без перемен, точка отсчёта и молчание — сообщения нет', () => {
    expect(ownerMessages([{ page, event: 'same' }, { page, event: 'baseline' }, { page, event: 'quiet' }])).toEqual([]);
  });
  // Отчёт 08.11 кончался «ещё изменений: 14 — полностью в partner_page_snapshots»:
  // таблицу базы владелец не читает, и эти 14 он не увидел вовсе.
  const changedPages = (n: number): PageReport[] => Array.from({ length: n }, (_, i) => ({
    page: { ...page, url: `https://volcanoesland.ru/tours/${i}/` },
    event: 'changed', diff: { removed: [`${'x'.repeat(196)} ${i}`], added: [`${'y'.repeat(196)} ${i}`] },
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
  // Находка проверки 10.11: анонс «Акция «11.11»…» стоит на каждой странице
  // «Лагуны»; его смена пришла бы блоком на каждую из тридцати с лишним страниц.
  describe('одна и та же правка на многих страницах партнёра — один блок', () => {
    const PROMO = 'Акция «11.11» - супервыгодные цены на многодневные туры 2026 - 2027';
    const laguna = (n: number) => ({ url: `https://laguna-expedition.ru/tours/${n}`, partnerName: 'Лагуна Экспедиция', tours: [`Тур ${n}`] });
    const changed = (n: number, removed: string[], added: string[] = []): PageReport => ({ page: laguna(n), event: 'changed', diff: { removed, added } });

    it('анонс пропал с пяти страниц: один блок со страницами, отдельных блоков нет', () => {
      const messages = ownerMessages([1, 2, 3, 4, 5].map((n) => changed(n, [PROMO])));
      expect(messages).toHaveLength(1);
      const [text] = messages;
      expect(text).toMatch(/^<b>Сайты партнёров: изменений — 1<\/b>/);
      expect(text).toContain('<b>Лагуна Экспедиция</b> — одна и та же правка на 5 страницах из 5 под наблюдением');
      expect(text.split(`было: ${PROMO}`)).toHaveLength(2);
      expect(text).toContain('страницы: тур «Тур 1», тур «Тур 2», тур «Тур 3», тур «Тур 4», тур «Тур 5»');
      expect(text).not.toContain('laguna-expedition.ru/tours/');
      expect(text).toContain('Наши карточки этих туров могли устареть');
    });

    it('у трёх из пяти заодно сменилась цена: своя строка — свой блок, и страницы названы свои', () => {
      const reports = [1, 2, 3, 4, 5].map((n) => (n <= 3
        ? changed(n, [PROMO, 'от 45 000 руб.'], ['от 40 500 руб.'])
        : changed(n, [PROMO])));
      const text = ownerMessages(reports).join('\n');
      expect(text).toMatch(/^<b>Сайты партнёров: изменений — 2<\/b>/);
      const [promoBlock, priceBlock] = text.split('\n\n').slice(1);
      expect(promoBlock).toContain('на 5 страницах из 5');
      expect(promoBlock).toContain(`было: ${PROMO}`);
      expect(promoBlock).not.toContain('45 000');
      expect(priceBlock).toContain('на 3 страницах из 5');
      expect(priceBlock).toContain('было: от 45 000 руб.\nстало: от 40 500 руб.');
      expect(priceBlock).toContain('страницы: тур «Тур 1», тур «Тур 2», тур «Тур 3»');
      expect(priceBlock).not.toContain('Тур 4');
    });

    it('у страницы есть и своё: общее — в своде, своё — отдельным блоком без общего', () => {
      const reports = [changed(1, [PROMO, 'Сбор в 08:00'], ['Сбор в 09:00']), changed(2, [PROMO]), changed(3, [PROMO])];
      const text = ownerMessages(reports).join('\n');
      expect(text).toMatch(/^<b>Сайты партнёров: изменений — 2<\/b>/);
      const ownBlock = text.split('\n\n')[2];
      expect(ownBlock).toContain('<b>Лагуна Экспедиция</b> — тур «Тур 1»\nlaguna-expedition.ru/tours/1\nбыло: Сбор в 08:00\nстало: Сбор в 09:00');
      expect(ownBlock).not.toContain(PROMO);
      expect(text.split(PROMO)).toHaveLength(2);
    });

    it('две страницы — ещё не весь сайт; чужой партнёр с той же строкой в свод не идёт', () => {
      expect(SITE_WIDE_MIN_PAGES).toBe(3);
      const two = ownerMessages([changed(1, [PROMO]), changed(2, [PROMO])]).join('\n');
      expect(two).not.toContain('одна и та же правка');
      expect(two.split(`было: ${PROMO}`)).toHaveLength(3);
      const other: PageReport = { page: { url: 'https://other.ru/t', partnerName: 'Другой', tours: ['Тур'] }, event: 'changed', diff: { removed: [PROMO], added: [] } };
      const mixed = ownerMessages([changed(1, [PROMO]), changed(2, [PROMO]), other]).join('\n');
      expect(mixed).not.toContain('одна и та же правка');
      expect(mixed).toContain('<b>Другой</b> — тур «Тур»');
    });

    it('страниц больше двенадцати — названы первые, остальные числом; «под наблюдением» считает и не менявшиеся', () => {
      const reports: PageReport[] = [
        ...Array.from({ length: 30 }, (_, i) => changed(i + 1, [PROMO])),
        { page: laguna(99), event: 'same' }, { page: laguna(100), event: 'quiet' },
      ];
      const text = ownerMessages(reports).join('\n');
      expect(text).toContain('одна и та же правка на 30 страницах из 32 под наблюдением');
      expect(text).toContain('тур «Тур 12» и ещё 18');
      expect(text).not.toContain('Тур 13');
      expect(text.length).toBeLessThan(4096);
    });

    it('строка пропала на одних страницах, а появилась на других — это разные правки', () => {
      const text = ownerMessages([changed(1, ['Гид'], []), changed(2, ['Гид'], []), changed(3, [], ['Гид']), changed(4, [], ['Гид'])]).join('\n');
      expect(text).not.toContain('одна и та же правка');
    });
  });

  it('страница больше потолка молчит после второго дня — о ней напоминает каждое сообщение, пока она не читается', () => {
    const big = { url: 'https://volcanoesland.ru/tours/big/', partnerName: 'Край Вулканов', tours: ['Большая'] };
    const change: PageReport = { page, event: 'changed', diff: { removed: ['Цена 1'], added: ['Цена 2'] } };
    const [text] = ownerMessages([change, { page: big, event: 'quiet', httpStatus: 200, tooBig: true }]);
    expect(text).toContain('Не читаются целиком и не сравниваются (больше потолка чтения): volcanoesland.ru/tours/big');
    // На второй день о ней сказано своим блоком — в хвосте не повторяется.
    const [second] = ownerMessages([{ page: big, event: 'failing', httpStatus: 200, tooBig: true }]);
    expect(second).toContain('второй день не прочитана; сегодня она больше потолка чтения');
    expect(second).not.toContain('Не читаются целиком и не сравниваются');
    // Сообщать больше нечего — ради напоминания сообщение не шлётся.
    expect(ownerMessages([{ page: big, event: 'quiet', httpStatus: 200, tooBig: true }])).toEqual([]);
    expect(ownerMessages([change])[0]).not.toContain('Не читаются целиком');
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
  // Находка проверки 10.11: строка календаря из одной даты считалась «скользящей».
  it('строка из одной даты с годом — дата выезда: перенос на неделю и новый выезд рядом с ушедшим видны', () => {
    const list = (...days: string[]) => ['Тур', 'Ближайшие выезды', ...days, 'Включено: обед'].join('\n');
    expect(meaningfulDiff(list('14 ноября 2026', '28 ноября 2026'), list('21 ноября 2026', '28 ноября 2026'), '2026-11-10')).toEqual({
      removed: ['14 ноября 2026'], added: ['21 ноября 2026'],
    });
    // 10-е ушло само, 12-е партнёр добавил: пара «10 → 12» прежде гасилась как сдвиг.
    expect(meaningfulDiff(list('10 ноября 2026', '28 ноября 2026'), list('12 ноября 2026', '28 ноября 2026'), '2026-11-10')).toEqual({
      removed: [], added: ['12 ноября 2026'],
    });
    expect(meaningfulDiff('Тур\n14.11.2026', 'Тур\n21.11.2026')).toEqual({ removed: ['14.11.2026'], added: ['21.11.2026'] });
    // Подпись с датой и дата без года — по-прежнему скользящие.
    expect(meaningfulDiff('Ближайший выезд: 14 ноября 2026', 'Ближайший выезд: 15 ноября 2026')).toBeNull();
    expect(meaningfulDiff('Тур\n4 ноября', 'Тур\n5 ноября')).toBeNull();
  });

  it('настоящая смена рядом со сдвигом остаётся в разнице', () => {
    const d = meaningfulDiff('Ближайший 4 ноября\nЦена 5 000 ₽', 'Ближайший 5 ноября\nЦена 6 000 ₽');
    expect(d).toEqual({ removed: ['Цена 5 000 ₽'], added: ['Цена 6 000 ₽'] });
  });
});

// Отчёт 08.11 о «Лагуне»: 29 «изменений», почти все — выезд, день которого
// наступил («было: 08 ноября 2026,» и «было: 08 ноября 2026»), и счётчик мест.
// Текст — как fullPageText страницы тура laguna-expedition.ru: начало и конец
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

  it('«Мест нет» — тот же счётчик на нуле: распродали, освободилось место, распроданный выезд ушёл — тишина', () => {
    const sold = departure('Понедельник', '09 ноября 2026', 'в 09:00', 'Мест нет');
    const one = departure('Понедельник', '09 ноября 2026', 'в 09:00', 'Осталось 1 место');
    expect(meaningfulDiff(tourPage(one, d10), tourPage(sold, d10), TODAY)).toBeNull();
    expect(meaningfulDiff(tourPage(sold, d10), tourPage(one, d10), TODAY)).toBeNull();
    const soldToday = departure('Воскресенье', '08 ноября 2026', 'в 10:00', 'Мест нет');
    expect(meaningfulDiff(tourPage(soldToday, d09, d10), tourPage(d09, d10), TODAY)).toBeNull();
    // Слова рядом — не счётчик.
    expect(meaningfulDiff(tourPage(d09), `${tourPage(d09)}\nМест нет в продаже до весны`, TODAY)).toEqual({
      removed: [], added: ['Мест нет в продаже до весны'],
    });
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

  // Отчёт 10.11: «было: 13 ноября 2026» у двух туров «Лагуны» — конец выезда
  // 10–13 ноября, ушедшего с календаря в день начала.
  describe('конец выезда, который уже начался', () => {
    const range = (wd1: string, start: string, wd2: string, end: string) => [
      'Начало тура', `${wd1},`, `${start},`, 'в 09:00', 'Окончание тура', `${wd2},`, end, 'от 45 000 руб.', 'Забронировать', 'Осталось 20 мест',
    ];
    const r10 = range('Вторник', '10 ноября 2026', 'Пятница', '13 ноября 2026');
    const r11 = range('Среда', '11 ноября 2026', 'Суббота', '14 ноября 2026');
    const r12 = range('Четверг', '12 ноября 2026', 'Воскресенье', '15 ноября 2026');
    const r13 = range('Пятница', '13 ноября 2026', 'Понедельник', '16 ноября 2026');
    const r14 = range('Суббота', '14 ноября 2026', 'Вторник', '17 ноября 2026');

    it('выезд 10–13 ноября ушёл в день начала: дата окончания в будущем — тишина', () => {
      expect(meaningfulDiff(tourPage(r10, r11, r12, r13, r14), tourPage(r11, r12, r13, r14), '2026-11-10')).toBeNull();
    });

    it('тот же выезд снят накануне — изменение: начало ещё не прошло', () => {
      expect(meaningfulDiff(tourPage(r10, r11, r12, r13, r14), tourPage(r11, r12, r13, r14), '2026-11-09')).toEqual({
        removed: ['10 ноября 2026,', '13 ноября 2026'], added: [],
      });
    });

    it('в тот же день снят и будущий выезд 12–15: его даты видны, конец начавшегося — нет', () => {
      expect(meaningfulDiff(tourPage(r10, r11, r12, r13, r14), tourPage(r11, r13, r14), '2026-11-10')).toEqual({
        removed: ['12 ноября 2026,', '15 ноября 2026'], added: [],
      });
    });

    it('список дат без слова об окончании: рядом с прошедшей пропала будущая — это снятый выезд', () => {
      const list = (...days: string[]) => ['Тур', 'Даты выездов', ...days, 'Цена 5 000 ₽'].join('\n');
      expect(meaningfulDiff(list('10 ноября 2026', '13 ноября 2026', '20 ноября 2026'), list('20 ноября 2026'), '2026-11-10')).toEqual({
        removed: ['13 ноября 2026'], added: [],
      });
    });

    it('та же дата стоит и концом ушедшего выезда, и отдельной строкой — не гасится', () => {
      const prev = [...tourPage(r10, r11).split('\n'), 'Сбор группы', '13 ноября 2026'].join('\n');
      expect(meaningfulDiff(prev, tourPage(r11), '2026-11-10')).toEqual({ removed: ['13 ноября 2026', 'Сбор группы'], added: [] });
    });

    it('начало выезда ищется не дальше восьми строк выше даты окончания', () => {
      const WEEK = ['Понедельник,', 'Вторник,', 'Среда,', 'Четверг,', 'Пятница,', 'Суббота,', 'Воскресенье,'];
      const block = (between: number) => ['Тур', '10 ноября 2026,', 'Окончание тура', ...WEEK.slice(0, between), '13 ноября 2026', ...WEEK];
      const after = (between: number) => block(between).filter((l) => !/ноября 2026/.test(l)).join('\n');
      // Начало на восьмой строке выше — тот же выезд; на девятой — уже нет.
      expect(meaningfulDiff(block(6).join('\n'), after(6), '2026-11-10')).toBeNull();
      expect(meaningfulDiff(block(7).join('\n'), after(7), '2026-11-10')).toEqual({ removed: ['13 ноября 2026'], added: [] });
    });

    // Находка проверки 10.11: однодневные выезды списком, у каждого строка о возвращении.
    it('список однодневных выездов со строкой «возвращение к 19:00»: снятый следующий выезд виден', () => {
      const card = (day: string) => [day, 'Сбор в 09:00, возвращение в город к 19:00', 'от 9 000 ₽', 'Забронировать'];
      const list = (...days: string[]) => ['Авачинский перевал', 'Ближайшие выезды', ...days.flatMap(card), 'В стоимость включено'].join('\n');
      expect(meaningfulDiff(
        list('10 ноября 2026', '12 ноября 2026', '14 ноября 2026'), list('14 ноября 2026'), '2026-11-10',
      )).toEqual({ removed: ['12 ноября 2026'], added: [] });
    });

    it('между началом и концом стоит цена или кнопка — это не одна карточка «начало — конец»', () => {
      const prev = ['Тур', '10 ноября 2026,', 'Окончание тура', 'от 9 000 ₽', '13 ноября 2026', 'от 9 000 ₽'];
      expect(meaningfulDiff(prev.join('\n'), ['Тур', 'Окончание тура', 'от 9 000 ₽'].join('\n'), '2026-11-10')).toEqual({
        removed: ['13 ноября 2026'], added: [],
      });
      // Подпись об окончании с цифрами — уже не подпись, а строка программы.
      const timed = ['Тур', '10 ноября 2026,', 'Окончание экскурсии в 18:00', '13 ноября 2026'];
      expect(meaningfulDiff(timed.join('\n'), 'Тур\nОкончание экскурсии в 18:00', '2026-11-10')).toEqual({ removed: ['13 ноября 2026'], added: [] });
    });

    it('между датой и прошедшим началом стоит другая дата — это не его конец', () => {
      const prev = ['Тур', '10 ноября 2026,', 'Окончание тура', '12 ноября 2026', 'Окончание тура', '13 ноября 2026'];
      const next = prev.filter((l) => l !== '10 ноября 2026,' && l !== '13 ноября 2026');
      expect(meaningfulDiff(prev.join('\n'), next.join('\n'), '2026-11-10')).toEqual({ removed: ['13 ноября 2026'], added: [] });
    });

    it('начало прошло, но со страницы не пропало: пропавший конец — изменение', () => {
      const moved = r10.map((l) => (l === '13 ноября 2026' ? '14 ноября 2026' : l));
      expect(meaningfulDiff(tourPage(r10), tourPage(moved), '2026-11-10')).toEqual({
        removed: ['13 ноября 2026'], added: ['14 ноября 2026'],
      });
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

// Проверка 10.11: страницу отдаёт чужой сервер, а сравнение идёт в процессе
// прода. Три места читали строку или список заново с каждой позиции: признак
// капчи на серии цифр (200 тыс. цифр — 52 с), признак «строка про срок» на
// артикуле (100 тыс. цифр — 12 с) и поиск скользящей даты каждой строки среди
// всех (8 000 сменившихся строк — 17 с). Правило у всех трёх прежнее.
describe('чужая страница не держит сравнение', () => {
  const ms = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it('капча узнаётся как раньше; строка из одних цифр — не капча', () => {
    // Эталон — признак до 10.11: первое число целиком, а не одной цифрой.
    const before = /\d+\s*[+\-−×*xх]\s*\d+\s*=\s*\?/i;
    const lines = [
      'Защита от роботов: 14+4=?', '123 × 5 = ?', '7x3=?', '9 − 2 =?', '5х5=?', '2+2 = ?', '2 + 2 2 = ?', '100 * 3=?',
      'Скидка 10+2=12%', '4+4', '=?', '12 + =?', 'x=?', '+4=?', '1'.repeat(500), `${'1'.repeat(500)}+`, 'Тур 5 дн + 2 ночи = ? руб',
    ];
    for (const line of lines) expect(isVolatileLine(line), line).toBe(before.test(line));
    expect(isVolatileLine('Защита от роботов: 14+4=?')).toBe(true);
    expect(isVolatileLine('1'.repeat(500))).toBe(false);
  });

  it('строка про срок — «9 часов», «12 ночей», «5 дн» — по-прежнему впереди', () => {
    const d = diffLines('', 'Обычная строка\nВ пути 9 часов\nПроживание 12 ночей\nТур на 5 дн\nЕщё строка');
    expect(d.added).toEqual(['В пути 9 часов', 'Проживание 12 ночей', 'Тур на 5 дн', 'Обычная строка', 'Ещё строка']);
    expect(diffLines('', 'Дни недели\nЧасть вторая').added).toEqual(['Дни недели', 'Часть вторая']);
  });

  it('пропавшей строке достаётся первая подходящая появившаяся, и каждая появившаяся занята один раз', () => {
    // Назад — не сдвиг; из двух подходящих берётся та, что стоит раньше.
    expect(withoutRollingShifts({ removed: ['Выезд 10 ноября'], added: ['Выезд 9 ноября', 'Выезд 12 ноября', 'Выезд 13 ноября'] }))
      .toEqual({ removed: [], added: ['Выезд 9 ноября', 'Выезд 13 ноября'] });
    expect(withoutRollingShifts({ removed: ['Выезд 10 ноября'], added: ['Выезд 20 ноября', 'Выезд 11 ноября'] }))
      .toEqual({ removed: [], added: ['Выезд 11 ноября'] });
    // Две пропавшие на одну появившуюся: вторая остаётся.
    expect(withoutRollingShifts({ removed: ['Выезд 10 ноября', 'Выезд 11 ноября'], added: ['Выезд 12 ноября'] }))
      .toEqual({ removed: ['Выезд 11 ноября'], added: [] });
    // Другие слова вокруг даты — не пара.
    expect(withoutRollingShifts({ removed: ['Выезд 10 ноября'], added: ['Заезд 11 ноября'] }))
      .toEqual({ removed: ['Выезд 10 ноября'], added: ['Заезд 11 ноября'] });
  });

  it('граница сдвига, Новый год, две даты в строке, невозможный день', () => {
    expect(withoutRollingShifts({ removed: ['Старт 1 ноября'], added: [`Старт ${1 + ROLLING_MAX_DAYS} ноября`] }).removed).toEqual([]);
    expect(withoutRollingShifts({ removed: ['Старт 1 ноября'], added: [`Старт ${2 + ROLLING_MAX_DAYS} ноября`] }).removed).toEqual(['Старт 1 ноября']);
    expect(withoutRollingShifts({ removed: ['Старт 25 декабря'], added: ['Старт 3 января'] })).toEqual({ removed: [], added: [] });
    expect(withoutRollingShifts({ removed: ['Старт 3 января'], added: ['Старт 25 декабря'] }).removed).toEqual(['Старт 3 января']);
    // Обе даты строки обязаны уйти вперёд.
    expect(withoutRollingShifts({ removed: ['с 10 ноября по 14 ноября'], added: ['с 11 ноября по 15 ноября'] })).toEqual({ removed: [], added: [] });
    expect(withoutRollingShifts({ removed: ['с 10 ноября по 14 ноября'], added: ['с 11 ноября по 13 ноября'] }).removed).toEqual(['с 10 ноября по 14 ноября']);
    expect(withoutRollingShifts({ removed: ['с 10 ноября по 14 ноября', 'с 10 ноября по 14 ноября'], added: ['с 12 ноября по 16 ноября'] }).removed)
      .toEqual(['с 10 ноября по 14 ноября']);
    // Та же дата — не сдвиг: ни у строки с одной датой, ни у строки с двумя.
    expect(withoutRollingShifts({ removed: ['Выезд 10 ноября'], added: ['Выезд 10 ноября'] }).removed).toEqual(['Выезд 10 ноября']);
    expect(withoutRollingShifts({ removed: ['с 10 ноября по 14 ноября'], added: ['с 10 ноября по 15 ноября'] }).removed).toEqual(['с 10 ноября по 14 ноября']);
    // Невозможный день и строка без дат парой не становятся.
    expect(withoutRollingShifts({ removed: ['Выезд 32 ноября', 'Тур'], added: ['Выезд 33 ноября', 'Тур'] }).removed).toEqual(['Выезд 32 ноября', 'Тур']);
  });

  it('серия цифр, артикул, тысячи сменившихся строк и календарь — доли секунды', () => {
    expect(ms(() => fullPageText('1'.repeat(100_000)))).toBeLessThan(1_000);
    expect(ms(() => fullPageText(`<p>${'7'.repeat(100_000)}</p>`))).toBeLessThan(1_000);
    expect(ms(() => diffLines(`Артикул ${'1'.repeat(50_000)}`, `Артикул ${'2'.repeat(50_000)}`))).toBeLessThan(1_000);
    const lines = (word: string) => Array.from({ length: 4_000 }, (_, i) => `${word} №${i}`).join('\n');
    expect(ms(() => meaningfulDiff(lines('Тур'), lines('Поход'), '2026-11-10'))).toBeLessThan(1_500);
    const calendar = (month: string) => Array.from({ length: 4_000 }, (_, i) => `Выезд ${1 + (i % 20)} ${month}`);
    expect(ms(() => withoutRollingShifts({ removed: calendar('ноября'), added: calendar('декабря') }))).toBeLessThan(1_000);
  }, 120_000);
});
