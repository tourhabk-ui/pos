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
  it('над туром — только ряд «Своя поездка / Радар» (владелец 26.09); чипы и предупреждения — ниже тура', () => {
    // С 25.09 строки поиска нет (владелец: «поиск лишний»). 26.09 владелец
    // поставил планировщик и радар над «Турами сезона»; тур остаётся первым
    // КОНТЕНТОМ под этим рядом, а чипы и строка обстановки — после него.
    const tools = pos('<nav className="qtools qt-top"');
    const block = pos('<section className="fp-sec"');
    const first = pos('className="firstpick"');
    expect(block).toBeGreaterThan(tools);
    expect(first).toBeGreaterThan(block);
    for (const later of ['<div className="hero-chips">', 'className="alerts-now"']) {
      expect(pos(later), `${later} снова выше первого тура`).toBeGreaterThan(first);
    }
  });

  it('карточка компактная: фото 16:9, а не почти квадрат', () => {
    const photo = rule('.v7 .firstpick .fp-photo');
    expect(photo).toMatch(/aspect-ratio:16\/9/);
    expect(photo).not.toMatch(/aspect-ratio:10\/11/);
  });

  it('карусель туров стоит перед секцией радара; сам радар — плитка, без заголовка и без дубля', () => {
    expect(pos('className="plates"')).toBeLessThan(pos('id="radar"'));
    expect(JSX).not.toMatch(/<h2>Радар обстановки<\/h2>/);
    // С 25.09 дверь радара — плитка в ряду инструментов (владелец: «экономить
    // место на мобильной»); строка-дубль в секции #radar снята.
    expect(JSX).toMatch(/href="\/safety#radar"\s+className="qt qt-radar"/);
    const radar = JSX.slice(pos('id="radar"'), JSX.indexOf('</section>', pos('id="radar"')));
    expect(radar).not.toContain('radarline');
  });

  it('заголовок не обещает подбора, которого нет', () => {
    expect(JSX).not.toMatch(/<h2>Подходит вам сейчас<\/h2>/);
    expect(JSX).toMatch(/<h2>Туры сезона<\/h2>/);
  });

  it('на карточках — факты из данных, а не слово-заглушка', () => {
    expect(CODE).not.toContain("'тур оператора'");
    expect((CODE.match(/plateFacts\(/g) ?? []).length, 'первая карточка и карусель — один источник фактов')
      .toBeGreaterThanOrEqual(2);
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

  it('точки озвучены «Тур N из M», а не «Плата N»', () => {
    expect(CODE).not.toMatch(/aria-label=\{`Плата/);
    expect(CODE).toMatch(/aria-label=\{`Тур \$\{i \+ 1\} из \$\{plates\.length\}`\}/);
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

  it('«Весь каталог» над каруселью туров ведёт в витрину туров', () => {
    const explore = JSX.slice(JSX.indexOf('<h2>Исследовать</h2>'), JSX.indexOf('className="plates"'));
    expect(explore).toContain('href="/catalog"');
    expect(explore).not.toContain('href="/routes"');
  });

  it('МЧС-строка не красная: --danger только у SOS и ошибок', () => {
    expect(rule('.v7 .mchsline')).not.toMatch(/--danger/);
  });

  it('«сезон кончился» набран читаемым цветом, предупреждение несёт иконка', () => {
    // Ревью 24.09: --warning (#D29922) 12px на --bg-card (#FFF) — ~2.5:1 при
    // требовании AA 4.5:1, а каталог ту же метку жёлтым не красит. Жёлтым
    // может быть только значок рядом (не текст), текст — --text-secondary.
    const textColors = [...CSS.matchAll(/\.v7 \.(?:plate \.avail|firstpick \.fp-avail)(?!\s*svg)[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1]);
    expect(textColors.length).toBeGreaterThan(0);
    for (const body of textColors) expect(body, body).not.toMatch(/color:\s*var\(--warning\)/);
    expect(JSX).toMatch(/className="avail"><CalendarX aria-hidden/);
    expect(JSX).toMatch(/className="fp-avail"><CalendarX aria-hidden/);
  });
});
