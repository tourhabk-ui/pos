/**
 * Мобильная главная: тур с ценой на первом экране, честная карусель и
 * работающая лид-форма (пакет П4, аудит 24.09).
 *
 * Что держит сторож и почему:
 *  · Порядок (решение владельца 24.09, пересмотр решения 29.07): первая
 *    карточка тура стоит сразу под поиском, карусель туров — перед радаром.
 *    Замер до правки: первый тур на 894px при экране 844, остальные семь — на
 *    1766px, за пятью плитками радара.
 *  · Карусель не листается сама (#42, WCAG 2.2.2) и не прижимает текст к
 *    кромке экрана (#38): scroll-padding-inline + смещение по offsetLeft.
 *  · Лид-форма (#3/#5/#35): «Отправить» не выключается галочкой — бледная
 *    кнопка молчала о причине, а ветка ошибки в submitLead была недостижима;
 *    поле телефона ужимается (min-width:0), иначе кнопка выезжала за экран.
 *  · Мелочи с видимой ценой: «1 мест» (#128), ссылка «Весь каталог» над
 *    туром — в витрину туров, а не в маршруты (#123), красный у МЧС-строки
 *    (развилка 2: красный — только SOS и ошибки).
 *
 * Проверяется разметка и CSS исходника: пикселей без браузера не измерить, но
 * источник каждой из этих ошибок — строка кода, и её возвращение ловится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
/** Только код: комментарии цитируют старые решения и заголовки. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
const CSS = SRC.slice(SRC.indexOf('const CSS = `'));
const JSX = CODE.slice(CODE.indexOf('<div className="wrap">'), CODE.indexOf('<BottomNav'));

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${esc}\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
}

function pos(marker: string): number {
  const at = JSX.indexOf(marker);
  expect(at, `в разметке главной не найден ${marker}`).toBeGreaterThan(-1);
  return at;
}

describe('тур с ценой — на первом экране', () => {
  it('над турами — только ряд «Своя поездка / Радар» (владелец 26.09); чипы и предупреждения — ниже ленты', () => {
    // С 25.09 строки поиска нет (владелец: «поиск лишний»). 26.09 владелец
    // поставил планировщик и радар над «Турами сезона»; лента туров — первый
    // КОНТЕНТ под этим рядом, а чипы и строка обстановки — после неё.
    const tools = pos('<nav className="qtools qt-top"');
    const block = pos('<section className="fp-sec"');
    const lane = pos('className="plates more-tours"');
    expect(block).toBeGreaterThan(tools);
    expect(lane).toBeGreaterThan(block);
    for (const later of ['{intentChips}', 'className="alerts-now"']) {
      expect(pos(later), `${later} снова выше ленты туров`).toBeGreaterThan(lane);
    }
  });

  it('крупной карточки первого тура над лентой нет (владелец 30.09: «ниже дублируются туры»)', () => {
    // Крупно стояла «Зимняя рыбалка: февраль — апрель», а сразу под ней в ленте
    // «ноябрь — январь» и «январь — март» — три почти одинаковые карточки подряд.
    expect(JSX).not.toContain('className="firstpick"');
    expect(CSS).not.toContain('.firstpick');
  });

  it('карусель туров стоит перед секцией радара; сам радар — плитка, без заголовка и без дубля', () => {
    expect(pos('className="plates more-tours"')).toBeLessThan(pos('id="radar"'));
    expect(JSX).not.toMatch(/<h2>Радар обстановки<\/h2>/);
    // С 25.09 дверь радара — плитка в ряду инструментов (владелец: «экономить
    // место на мобильной»); строка-дубль в секции #radar снята.
    // Вечер 26.09: плитка радара — прямо дверь на /safety#radar (владелец:
    // «по кнопке радар должен открываться наш радар»), без раскрытой сводки.
    expect(JSX).toMatch(/href="\/safety#radar"\s+className="qt qt-radar"/);
    expect(JSX).not.toMatch(/id="radar-panel"/);
    const radar = JSX.slice(pos('id="radar"'), JSX.indexOf('</section>', pos('id="radar"')));
    expect(radar).not.toContain('radarline');
  });

  it('заголовок не обещает подбора, которого нет', () => {
    expect(JSX).not.toMatch(/<h2>Подходит вам сейчас<\/h2>/);
    expect(JSX).toMatch(/<h2>Туры сезона<\/h2>/);
  });

  it('на карточках — факты из данных, а не слово-заглушка', () => {
    expect(CODE).not.toContain("'тур оператора'");
    expect(CODE, 'факты карточки ленты — из plateFacts').toMatch(/const pf = plateFacts\(p\)/);
  });
});

describe('карусель', () => {
  it('не листается сама: ни setInterval, ни автозапуска', () => {
    expect(CODE).not.toMatch(/setInterval\(/);
  });

  it('текст карточки не прижимается к кромке экрана', () => {
    expect(rule('.v7 .plates')).toMatch(/scroll-padding-inline:20px/);
    expect(CODE, 'смещение снова считается как i * ширина — snap прижмёт карточку к x=0')
      .not.toMatch(/scrollTo\(\{\s*left:\s*i\s*\*/);
    expect(CODE).toMatch(/offsetLeft/);
    expect(rule('.v7 .plate .row')).toMatch(/padding:\d+px 12px/);
  });

  it('точки озвучены «Карточка N из M», а не «Плата N»', () => {
    expect(CODE).not.toMatch(/aria-label=\{`Плата/);
    // С 30.09 лента — все туры витрины, с первого: номер i + 1. С 09.10 в ней
    // и трансфер, поэтому точка — «Карточка», а сама карточка называет род.
    expect(CODE).toMatch(/aria-label=\{`Карточка \$\{i \+ 1\} из \$\{cards\.length\}`\}/);
    expect(CODE).toMatch(/`Карточка \$\{i \+ 1\} из \$\{cards\.length\}: тур`/);
    expect(CODE).toMatch(/`Карточка \$\{i \+ 1\} из \$\{cards\.length\}: трансфер`/);
  });

  it('CTA — кнопка не ниже 44px и не мельче 13px', () => {
    const cta = rule('.v7 .plate .buy-cta');
    expect(cta).toMatch(/min-height:44px/);
    const fs = /font:\d+ ([\d.]+)px/.exec(cta)?.[1];
    expect(Number(fs)).toBeGreaterThanOrEqual(13);
  });
});

describe('лид-форма главной', () => {
  it('«Отправить» не выключается галочкой — гейт в обработчике, с ошибкой и фокусом', () => {
    const btn = /<button onClick=\{submitLead\}[^>]*>/.exec(CODE)?.[0] ?? '';
    expect(btn, 'кнопка отправки не найдена').not.toBe('');
    expect(btn, 'кнопка снова молча бледнеет без галочки').not.toMatch(/!pdConsent/);
    const submit = CODE.slice(CODE.indexOf('const submitLead'), CODE.indexOf("setSending(true)"));
    expect(submit, 'без галочки запрос обязан не уходить').toMatch(/if \(!pdConsent\)/);
    expect(submit, 'фокус — на галочку').toMatch(/'pd-consent-home'/);
    expect(CODE).toMatch(/<div className="err" role="alert">/);
  });

  it('поле телефона ужимается — кнопка не выезжает за рамку', () => {
    expect(rule('.v7 .lead .field input')).toMatch(/min-width:0/);
  });

  it('сноски читаются: Outfit 12px --text-secondary, ссылка на политику — --ocean с подчёркиванием', () => {
    const fine = rule('.v7 .lead .fine');
    expect(fine).toMatch(/var\(--font-outfit\)/);
    expect(fine).not.toMatch(/var\(--fm\)/);
    expect(Number(/font:\d+ ([\d.]+)px/.exec(fine)?.[1])).toBeGreaterThanOrEqual(12);
    expect(fine).toMatch(/color:var\(--text-secondary\)/);
    const a = rule('.v7 .lead .fine a');
    expect(a).toMatch(/color:var\(--ocean\)/);
    expect(a).toMatch(/text-decoration:underline/);
  });
});

describe('мелочи с видимой ценой', () => {
  it('«мест» склоняется', () => {
    expect(CODE).not.toMatch(/\{el\.count\} мест</);
    expect(CODE).toMatch(/plural\(el\.count, 'место', 'места', 'мест'\)/);
  });

  it('ряд цифр на телефоне переносится, а не прячется в скрытый скролл', () => {
    expect(CSS).toMatch(/@media \(max-width:480px\)\{[^@]*\.v7 \.dataline\{[^}]*flex-wrap:wrap/);
  });

  it('«Все туры» над турами ведёт в витрину туров, «Все места» — в каталог мест', () => {
    const tours = JSX.slice(JSX.indexOf('<h2>Туры сезона</h2>'), JSX.indexOf('className="plates more-tours"'));
    expect(tours).toContain('href="/catalog"');
    expect(tours).not.toContain('href="/routes');
    const explore = JSX.slice(JSX.indexOf('<h2>Исследовать</h2>'), JSX.indexOf('className="plates explore"'));
    expect(explore).toContain('href="/routes?kind=place"');
    expect(explore).not.toContain('href="/catalog"');
  });

  it('МЧС-строка не красная: --danger только у SOS и ошибок', () => {
    expect(rule('.v7 .mchsline')).not.toMatch(/--danger/);
  });

  it('«сезон кончился» набран читаемым цветом, предупреждение несёт иконка', () => {
    // Ревью 24.09: --warning (#D29922) 12px на --bg-card (#FFF) — ~2.5:1 при
    // требовании AA 4.5:1, а каталог ту же метку жёлтым не красит. Жёлтым
    // может быть только значок рядом (не текст), текст — --text-secondary.
    const textColors = [...CSS.matchAll(/\.v7 \.plate \.avail(?!\s*svg)[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1]);
    expect(textColors.length).toBeGreaterThan(0);
    for (const body of textColors) expect(body, body).not.toMatch(/color:\s*var\(--warning\)/);
    expect(JSX).toMatch(/className="avail"><CalendarX aria-hidden/);
  });
});

describe('два направления и безопасность одним местом (владелец 25.09)', () => {
  it('тур показывается один раз: одна лента всех туров витрины', () => {
    expect(CODE).toMatch(/const tours = plates;/);
    // Одна лента. С 04.10 при дрейфе она рендерится дважды подряд — петля
    // (hooks/use-plate-drift), вторая копия aria-hidden: та же лента, не
    // второй блок туров.
    const ribbons = (JSX.match(/\{tours\.map\(\(p, i\) =>/g) ?? []).length
      + (JSX.match(/\{\(drift\.looping \? \[\.\.\.cards, \.\.\.cards\] : cards\)\.map\(/g) ?? []).length;
    // С 09.10 в ленте между турами — карточка трансфера (cards = туры + она).
    expect(CODE).toMatch(/const cards = withTransferPlate\(tours, data\.transfer\);/);
    expect(ribbons).toBe(1);
  });

  it('лента туров — внутри «Туров сезона»; направления — под лентой (владелец 30.09)', () => {
    const fp = pos('<h2>Туры сезона</h2>');
    expect(fp).toBeLessThan(pos('className="plates more-tours"'));
    expect(pos('className="plates more-tours"')).toBeLessThan(pos('{intentChips}'));
    expect(pos('{intentChips}')).toBeLessThan(pos('id="radar"'));
    // Пустая витрина не прячет входы в места: ряд остаётся без туров.
    expect(JSX).toMatch(/\) : intentChips\}/);
  });

  it('«Перед выходом»: предупреждения и полевые инструменты в одной секции #radar', () => {
    const at = pos('id="radar"');
    const radar = JSX.slice(at, JSX.indexOf('</section>', at));
    expect(radar).toContain('<h2>Перед выходом</h2>');
    expect(radar).toContain('className="alerts-now"');
    expect(radar).toContain('<nav className="qtools stools"');
    expect(radar.indexOf('className="alerts-now"')).toBeLessThan(radar.indexOf('<nav className="qtools stools"'));
  });

  it('«Исследовать» — места после «Перед выходом»: без цены и без брони (§9)', () => {
    expect(pos('id="radar"')).toBeLessThan(pos('<h2>Исследовать</h2>'));
    const at = pos('className="plates explore"');
    const explore = JSX.slice(at, JSX.indexOf('</section>', at));
    // Ссылка по ЧПУ, по id — только без slug (аудит 02.10, home-explore-slug).
    expect(explore).toContain('href={`/places/${pl.urlSlug ?? pl.id}`}');
    expect(explore).not.toMatch(/price|buy-cta|Забронировать|marketplace/);
  });
});
