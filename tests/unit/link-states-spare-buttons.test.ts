/**
 * Состояния ссылок не красят ссылку-кнопку в цвет её фона; подписи и
 * заглушки читаются в обеих темах.
 *
 * ── Что нашлось (аудит П1, #13/#14/#91) ───────────────────────────────────
 *
 * В app/globals.css вне слоя стояло `a:hover { color: var(--accent) }`.
 * Специфичность (0,1,1) выше, чем у `.ds-btn-primary` (0,1,0) из
 * `@layer components` (в Tailwind 3 слой не нативный), — и под указателем,
 * а на телефоне после тапа (:hover там залипает) подпись главной кнопки
 * брони становилась того же цвета, что фон: пустая оранжевая плашка. Тем же
 * механизмом `a:visited` давал кнопке голубой текст. Ссылок вида
 * `<a class="ds-btn ds-btn-primary">` на сайте два десятка.
 *
 * ── Что нашлось (аудит П1, #71/#85/#95/#141) ──────────────────────────────
 *
 * `.ds-label` красился --text-muted — токеном, отведённым плейсхолдерам
 * (DESIGN_SYSTEM.md): 1.84:1 в тёмной теме, 2.97:1 в светлой. Метки формы
 * брони почти не читались. `.ds-skeleton` имел фон --bg-card и внутри
 * карточки того же фона был невидим — после «Выбрать дату» ~290px пустоты.
 * В светлом блоке токенов не было --telegram: кнопка Telegram во всплывашке
 * «Хочу тур» становилась прозрачной с белым текстом на белом.
 *
 * ── Приёмка 24.09 ──────────────────────────────────────────────────────────
 *
 * Первая правка исключала ds-btn голым `a:not(.ds-btn, ...)`. :not весит как
 * свой самый специфичный аргумент, и правило выросло до (0,2,1): перебило
 * hover:text-* на ссылках по всему сайту, а ссылку-кнопку без ds-btn
 * (text-white + hover:bg-accent на /catalog) не спасло. Теперь сторож
 * считает специфичность и слой, а не только список исключений.
 *
 * Сторож считает контраст по самим токенам, а не сверяет имя: поменяй
 * значение --text-secondary на бледное — краснеет здесь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ');

const BUTTON_CLASSES = ['.ds-btn', '.ds-btn-primary', '.ds-btn-secondary', '.ds-btn-danger'];

/** Все правила файла вместе со слоем, в котором лежат (null — вне @layer). */
function allRules(css: string, layer: string | null = null): Array<{ selector: string; body: string; layer: string | null }> {
  const out: Array<{ selector: string; body: string; layer: string | null }> = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    // найти парную скобку
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    const at = selector.match(/^@layer\s+([\w-]+)/);
    if (at) out.push(...allRules(inner, at[1]));
    else if (selector.startsWith('@media') || selector.startsWith('@supports')) out.push(...allRules(inner, layer));
    else if (!selector.startsWith('@')) out.push({ selector, body: inner, layer });
    i = j;
  }
  return out;
}

/** Содержимое скобок после позиции open (open указывает на «(»), с учётом вложенности. */
function balanced(s: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') { depth--; if (depth === 0) return { inner: s.slice(open + 1, k), end: k + 1 }; }
  }
  throw new Error(`несбалансированные скобки в «${s}»`);
}

type Spec = [number, number, number];
const cmp = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Специфичность по Selectors 4 — ровно столько, сколько нужно здесь:
 * :where(...) — ноль; :not/:is/:has — самый специфичный аргумент;
 * прочие псевдоклассы, классы, атрибуты — (0,1,0); элементы — (0,0,1).
 */
function specificity(sel: string): Spec {
  const out: Spec = [0, 0, 0];
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    const fn = sel.slice(i).match(/^:(where|not|is|has)\(/);
    if (fn) {
      const { inner, end } = balanced(sel, i + fn[0].length - 1);
      if (fn[1] !== 'where') {
        const best = splitSelectors(inner).map(specificity).sort(cmp).pop()!;
        out[0] += best[0]; out[1] += best[1]; out[2] += best[2];
      }
      i = end;
      continue;
    }
    if (ch === '#') { out[0]++; i++; while (i < sel.length && /[\w-]/.test(sel[i])) i++; continue; }
    if (ch === '.' || (ch === ':' && sel[i + 1] !== ':')) {
      out[1]++; i++;
      // имя с экранированием (.hover\:text-white): «\» съедает следующий символ
      while (i < sel.length && (/[\w-]/.test(sel[i]) || sel[i] === '\\')) i += sel[i] === '\\' ? 2 : 1;
      if (sel[i] === '(') i = balanced(sel, i).end;
      continue;
    }
    if (ch === '[') { out[1]++; i = sel.indexOf(']', i) + 1; continue; }
    if (ch === ':' ) { out[2]++; i += 2; while (i < sel.length && /[\w-]/.test(sel[i])) i++; continue; }
    if (/[a-zA-Z]/.test(ch)) { out[2]++; while (i < sel.length && /[\w-]/.test(sel[i])) i++; continue; }
    i++;
  }
  return out;
}

/** Список селекторов через запятую — без разрезания запятых внутри :not(...). */
function splitSelectors(sel: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim());
}

function block(selector: string): string {
  const i = CSS.indexOf(selector);
  expect(i, `блок ${selector} не найден в globals.css`).toBeGreaterThanOrEqual(0);
  return CSS.slice(i, CSS.indexOf('}', i));
}

function hex(tokenBlock: string, name: string): string {
  const m = tokenBlock.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  expect(m, `токен ${name} не найден`).toBeTruthy();
  return m![1];
}

function lum(h: string): number {
  const c = [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('ссылочные состояния не трогают ссылки-кнопки и не перебивают утилиты', () => {
  const rules = allRules(CSS);
  const isState = (sel: string) => /(^|[\s(;}])a(?![\w-])[^{]*:(hover|visited|active)\b/.test(sel);
  const stateRules = rules.filter(r =>
    splitSelectors(r.selector).some(isState) && /(^|[\s;])color\s*:/.test(r.body),
  );

  // Утилита Tailwind: .text-white = (0,1,0); .hover\:text-white:hover = (0,2,0).
  const UTILITY: Spec = [0, 1, 0];
  const HOVER_UTILITY: Spec = [0, 2, 0];

  it('самопроверка счёта специфичности', () => {
    expect(specificity('a:hover')).toEqual([0, 1, 1]);
    expect(specificity('a:not(.ds-btn, .ds-btn-primary):hover')).toEqual([0, 2, 1]);
    expect(specificity(':where(a:not(.ds-btn, .ds-btn-primary)):hover')).toEqual([0, 1, 0]);
    expect(specificity('.hover\\:text-white:hover')).toEqual(HOVER_UTILITY);
  });

  it('правила a:hover/:visited/:active существуют (иначе проверять нечего)', () => {
    expect(stateRules.length).toBeGreaterThanOrEqual(3);
  });

  it('каждое красящее состояние ссылки исключает все варианты ds-btn', () => {
    for (const r of stateRules) {
      const at = r.selector.indexOf(':not(');
      expect(at, `«${r.selector}» перекрашивает и ссылки-кнопки — подпись сольётся с фоном`).toBeGreaterThanOrEqual(0);
      const args = splitSelectors(balanced(r.selector, at + 4).inner);
      for (const cls of BUTTON_CLASSES) {
        expect(args, `«${r.selector}» не исключает ${cls}`).toContain(cls);
      }
    }
  });

  // Аудит П1, приёмка 24.09: голый a:not(.ds-btn,...):hover — это (0,2,1).
  // Он перебил hover:text-white у крошек поверх фото тура (стали акцентными),
  // а «Забронировать» на /catalog — <Link> с text-white и hover:bg-[--accent]
  // без ds-btn — всё равно пустела: (0,2,1) бьёт .text-white (0,1,0).
  // Цвет, который ссылке дала утилита, обязан побеждать. Поэтому состояние
  // не специфичнее одной утилиты И лежит в @layer base, который Tailwind
  // выводит ДО утилит, — при равной специфичности выигрывает утилита.
  it('состояние ссылки не специфичнее одной утилиты (text-white на ссылке-кнопке побеждает)', () => {
    for (const r of stateRules) {
      for (const sel of splitSelectors(r.selector).filter(isState)) {
        const sp = specificity(sel);
        expect(cmp(sp, UTILITY), `«${sel}» = (${sp}) перебивает .text-white (0,1,0) — подпись кнопки сольётся с фоном`).toBeLessThanOrEqual(0);
        expect(cmp(sp, HOVER_UTILITY), `«${sel}» перебивает hover:text-*`).toBeLessThan(0);
      }
    }
  });

  it('состояния ссылок лежат в @layer base — до утилит в сборке', () => {
    for (const r of stateRules) {
      expect(r.layer, `«${r.selector}» вне @layer base: при равной специфичности окажется ПОСЛЕ утилит и перебьёт их`).toBe('base');
    }
  });
});

describe('подписи и заглушки читаются', () => {
  const dark = block(':root[data-theme="dark"]');
  const light = block(':root[data-theme="light"]');

  it('.ds-label — --text-secondary, не плейсхолдерный --text-muted', () => {
    expect(block('.ds-label {')).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it('--text-secondary на карточке — не ниже 4.5:1 в обеих темах', () => {
    for (const [name, t] of [['тёмная', dark], ['светлая', light]] as const) {
      const c = contrast(hex(t, '--text-secondary'), hex(t, '--bg-card'));
      expect(c, `${name}: --text-secondary на --bg-card = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('.ds-skeleton отличим от карточки, внутри которой лежит', () => {
    const sk = block('.ds-skeleton {');
    const bg = sk.match(/background:\s*var\((--[\w-]+)\)/);
    expect(bg, 'у .ds-skeleton нет фона-токена').toBeTruthy();
    expect(bg![1], 'заглушка того же цвета, что карточка, — невидима').not.toBe('--bg-card');
    for (const t of [dark, light]) {
      expect(hex(t, bg![1])).not.toBe(hex(t, '--bg-card'));
    }
  });

  it('--telegram объявлен в каждом блоке темы', () => {
    for (const sel of [':root[data-theme="dark"]', ':root[data-theme="light"]', ':root:not([data-theme])']) {
      expect(block(sel), `в ${sel} нет --telegram — кнопка Telegram станет прозрачной`).toMatch(/--telegram:/);
    }
  });
});
