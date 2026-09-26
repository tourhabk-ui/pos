/**
 * Главная называет опасность, а не только красит точку.
 *
 * 10.08 владелец открыл vedarai.ru при девятнадцати действующих
 * предупреждениях, одно из них важности 2 («Сохраняется риск схода оползней и
 * обвалов с вулкана Мутновского»), и написал: «ни слова об опасности».
 *
 * Он прочитал ровно то, что было написано. Главная показывала СОСТОЯНИЕ —
 * цветную пилюлю в шапке и строку свежести данных. Сама лента предупреждений
 * (`AlertsTicker`) висела только на /safety, за переходом. Ни одного слова о
 * том, ЧТО случилось, на первом экране не было.
 *
 * Дефект того же рода, что весь этот день: сигнал есть, содержания нет, и
 * отсутствие содержания выглядит как отсутствие опасности.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const LIVE = readFileSync(join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8');

describe('на главной есть текст предупреждения', () => {
  it('заголовки алертов рендерятся, а не только считаются', () => {
    // `safety.alerts` приходил в клиент и не использовался ни разу. С 26.09
    // заголовки печатает общая лента (AlertsTicker) — ей и отдаётся список.
    expect(HOME).toMatch(/<AlertsTicker alerts=\{safety\.alerts\}/);
    expect(LIVE).toContain('{a.title}');
  });

  it('блок скрыт, когда предупреждений нет', () => {
    // Пустая рамка «всё спокойно» — обещание, которого мы дать не можем: это
    // тот же дефект, что чинили в радаре и в ленте зон.
    expect(HOME).toMatch(/safety\.alerts\.length\s*>\s*0\s*&&/);
  });

  it('есть переход к полному списку', () => {
    const block = HOME.slice(HOME.indexOf('alerts-now'), HOME.indexOf('alerts-now') + 3600);
    expect(block).toContain('/safety');
  });
});

describe('главная и /safety — одна лента, а не две копии (26.09)', () => {
  it('главная рендерит ту же AlertsTicker из LiveStatus', () => {
    expect(HOME).toMatch(/import \{[^}]*AlertsTicker[^}]*\} from '@\/components\/safety\/LiveStatus'/);
    expect(HOME).toMatch(/<style dangerouslySetInnerHTML=\{\{ __html: LIVE_STATUS_CSS \}\} \/>/);
  });

  it('своей подписи, обрезки и списка на главной не заведено', () => {
    expect(HOME).not.toMatch(/function\s+alertStamp\s*\(/);
    expect(HOME).not.toMatch(/function\s+clip\s*\(/);
    expect(HOME).not.toMatch(/className="an-row"/);
  });
});

describe('важность видна цветом по правилу платформы', () => {
  it('у строки есть класс уровня, порог красного — 2, как у пилюли и статуса мест', () => {
    expect(LIVE).toMatch(/a\.severity >= 2 \? 'sev-hi' : a\.severity === 1 \? 'sev-mid' : 'sev-lo'/);
  });

  it('цвета — токены, без хардкода', () => {
    const css = LIVE.slice(LIVE.indexOf('.kh-live .alerts i.sev-hi'), LIVE.indexOf('.kh-live .alerts i.sev-hi') + 300);
    expect(css).toContain('var(--danger)');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

/**
 * Владелец 26.09: «блок безопасности был интерактивный, новости снизу вверх
 * писались; уменьши сам блок, пусть он будет 4 строчки, но интерактивные — с
 * возможностью развернуть и свернуть». Сменило решение 25.09 («на 3 строчки,
 * с раскрытием каждой строки»).
 */
describe('лента на главной: две новости целиком, бежит снизу вверх, разворачивается', () => {
  it('главная просит окно на две новости (владелец 26.09, вечер)', () => {
    expect(HOME).toMatch(/<AlertsTicker alerts=\{safety\.alerts\} lines=\{2\} \/>/);
  });

  it('новость целиком: без обрезки многоточием; дата и описание — только в развёрнутой', () => {
    expect(LIVE).toMatch(/\.ticker\.compact\.scroll:not\(\.open\)\{height:calc\(var\(--tk-rows\) \* 46px\)\}/);
    expect(LIVE).not.toMatch(/\.ticker\.compact:not\(\.open\) \.alerts \.atx\{white-space:nowrap/);
    expect(LIVE).toMatch(/\.ticker\.compact:not\(\.open\) \.alerts \.adesc,\.kh-live \.ticker\.compact:not\(\.open\) \.alerts \.ago\{display:none\}/);
  });

  it('бег снизу вверх — только в свёрнутой длинной ленте', () => {
    expect(LIVE).toMatch(/const animate = scroll && !open/);
    expect(LIVE).toMatch(/@keyframes v7-ticker\{from\{transform:translateY\(0\)\}to\{transform:translateY\(-50%\)\}\}/);
  });

  it('раскрывашка в компактной ленте есть всегда — деталь в строку не влезает', () => {
    expect(LIVE).toMatch(/\{\(scroll \|\| compact\) && \(/);
    expect(LIVE).toMatch(/aria-expanded=\{open\}/);
  });

  it('без анимации окно не растягивается во весь список', () => {
    expect(LIVE).toMatch(/prefers-reduced-motion:reduce\)\{\.kh-live \.ticker\.compact\.scroll:not\(\.open\)\{height:calc/);
  });
});
