/**
 * Тач-зоны главной не меньше 44px.
 *
 * Правило §3 дизайн-языка, и оно нарушалось молча. Внешнее ревью на 390x844
 * сняло геометрию из DOM и нашло: ссылка «Карта сегодня» — 9.5px высотой,
 * поле поиска — 16.8px при крупной видимой рамке, иконки шапки — 32px.
 * Видимая рамка и зона нажатия разъехались, и на глаз это незаметно: элемент
 * выглядит крупным, а палец промахивается.
 *
 * Сторож не может измерить пиксели без браузера, но может поймать источник
 * ошибки — объявленную в CSS высоту меньше 44px у того, по чему человек
 * нажимает.
 *
 * Список интерактивных классов НЕ задан руками: он извлекается из самой
 * разметки — какие className висят на a/button/input/Link. Поэтому новый
 * элемент попадает под сторожа сам, без правки теста.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIN_TOUCH_PX = 44;
const SRC = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');

/** Классы, висящие на интерактивных тегах в JSX. */
function interactiveClasses(): Set<string> {
  const out = new Set<string>();
  for (const m of SRC.matchAll(/<(Link|a|button|input)\b([^>]*)>/gs)) {
    const cls = /className=["']([^"']+)["']/.exec(m[2]);
    if (cls) for (const c of cls[1].split(/\s+/).filter(Boolean)) out.add(c);
  }
  return out;
}

/** Правила из <style jsx global> — селектор и его объявления. */
function cssRules(): { selector: string; body: string }[] {
  return [...SRC.matchAll(/([^{}\n]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => r.selector.startsWith('.v7') || r.selector.includes('.v7'));
}

/**
 * Последняя простая часть селектора — то, по чему реально кликают.
 * `.v7 nav.tabs a .ico` целится в глиф внутри ссылки, а не в саму ссылку,
 * поэтому его высота 28px законна: зона нажатия принадлежит родителю.
 */
function target(selector: string): string {
  const parts = selector.trim().split(/\s+|>/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function isInteractiveTarget(sel: string, classes: Set<string>): boolean {
  const t = target(sel);
  if (/(^|\.)(a|button|input)$/.test(t)) return true;
  // .v7 .icn / .hchip / .chip — класс на Link или button
  const cls = t.split('.').filter(Boolean).pop();
  return !!cls && classes.has(cls);
}

/** Объявленная высота в px. null — высота не задана (её решает padding). */
function declaredHeight(body: string): number | null {
  const m = /(?:^|;)\s*(?:min-)?height\s*:\s*([\d.]+)px/.exec(body);
  return m ? parseFloat(m[1]) : null;
}

describe('тач-зоны главной', () => {
  const classes = interactiveClasses();

  it('разметка вообще разобралась — иначе сторож молчал бы впустую', () => {
    expect(classes.size).toBeGreaterThan(5);
    expect(cssRules().length).toBeGreaterThan(50);
  });

  it('ни одно интерактивное правило не объявляет высоту меньше 44px', () => {
    const offenders = cssRules()
      .filter((r) => r.selector.split(',').some((s) => isInteractiveTarget(s, classes)))
      .map((r) => ({ selector: r.selector, h: declaredHeight(r.body) }))
      .filter((r) => r.h !== null && r.h < MIN_TOUCH_PX)
      .map((r) => `${r.selector} → ${r.h}px`);

    expect(offenders, `тач-зона меньше ${MIN_TOUCH_PX}px`).toEqual([]);
  });

  it('фокус виден с клавиатуры — outline не снят без замены', () => {
    expect(SRC).toMatch(/:focus-visible\{[^}]*outline:\s*2px/);
    // Снять outline и ничего не дать взамен — потерять положение курсора
    // у человека с клавиатурой или switch-control.
    const stripped = [...SRC.matchAll(/([^{}\n]+)\{([^{}]*)\}/g)]
      .filter((m) => /outline:\s*(none|0)\b/.test(m[2]))
      .map((m) => m[1].trim())
      .filter((sel) => !new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*:focus-visible`).test(SRC));
    // Поле поиска гасит собственный outline, но его перекрывает общее
    // правило .v7 input:focus-visible — это допустимо.
    expect(stripped.every((s) => /input|textarea/.test(s)), `outline снят без замены: ${stripped}`).toBe(true);
  });
});
