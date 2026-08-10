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

describe('на главной есть текст предупреждения', () => {
  it('заголовки алертов рендерятся, а не только считаются', () => {
    // `safety.alerts` приходил в клиент и не использовался ни разу.
    expect(HOME).toMatch(/safety\.alerts\s*\.\s*slice|safety\.alerts\.slice/);
    expect(HOME).toContain('a.title');
  });

  it('блок скрыт, когда предупреждений нет', () => {
    // Пустая рамка «всё спокойно» — обещание, которого мы дать не можем: это
    // тот же дефект, что чинили в радаре и в ленте зон.
    expect(HOME).toMatch(/safety\.alerts\.length\s*>\s*0\s*&&/);
  });

  it('есть переход к полному списку', () => {
    const block = HOME.slice(HOME.indexOf('alerts-now'), HOME.indexOf('alerts-now') + 1600);
    expect(block).toContain('/safety');
  });
});

describe('главная и /safety говорят об одном предупреждении одинаково', () => {
  it('подпись и обрезка берутся из общего модуля, а не пишутся заново', () => {
    // Две копии одной подписи неизбежно разойдутся — так уже было с SOS-кнопкой
    // и с карточкой тура. Импорт из LiveStatus — единственный источник.
    expect(HOME).toMatch(/import \{[^}]*alertStamp[^}]*\} from '@\/components\/safety\/LiveStatus'/);
    expect(HOME).toMatch(/import \{[^}]*clip[^}]*\} from '@\/components\/safety\/LiveStatus'/);
  });

  it('своей функции подписи на главной не заведено', () => {
    expect(HOME).not.toMatch(/function\s+alertStamp\s*\(/);
    expect(HOME).not.toMatch(/function\s+clip\s*\(/);
  });
});

describe('важность видна цветом, а не только порядком', () => {
  it('у строки есть класс уровня', () => {
    expect(HOME).toContain('sev-hi');
    expect(HOME).toContain('sev-mid');
  });

  it('цвета — токены, без хардкода', () => {
    const css = HOME.slice(HOME.indexOf('.v7 .alerts-now'), HOME.indexOf('.v7 .alerts-now') + 1200);
    expect(css).toContain('var(--danger)');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
