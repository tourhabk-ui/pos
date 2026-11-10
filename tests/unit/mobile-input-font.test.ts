/**
 * tests/unit/mobile-input-font.test.ts
 *
 * Поле ввода на телефоне — не мельче 16 px (app/globals.css, разбор
 * meta/astryx 10.11, контракт mobile-typography DR1). iOS Safari увеличивает
 * страницу при фокусе на поле со шрифтом меньше 16 px — на 10.11 так было у
 * 151 поля, среди них форма SOS и спутниковая диктовка.
 *
 * Правило живёт в CSS, и судится сам артефакт по смыслу (§13.10):
 *  - правило — под `(pointer: coarse)`, вне @layer и после `@tailwind
 *    utilities`: иначе класс text-sm на поле его перебьёт;
 *  - первое правило — пол 16 px для поля, наследующего мелкий шрифт родителя;
 *  - второе — 16 px для поля с мелким классом, и оно покрывает КАЖДЫЙ мелкий
 *    класс, который сегодня стоит на полях в app/ и components/: новый
 *    text-[13px] на поле без строчки в CSS — красный;
 *  - запрет: шрифт поля в style={{}} — стилем его не перебить.
 *
 * Что правило действительно работает в браузере (телефон — 16 px, компьютер
 * — как свёрстано), проверено один раз Playwright'ом на собранном CSS, итог в
 * PR; здесь — то, что держит его на месте.
 */
import { describe, it, expect } from 'vitest';
import postcss, { type AtRule, type Rule } from 'postcss';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const root = postcss.parse(CSS);

/** Поля, которым шрифт не нужен: флажки, переключатели, кнопки. */
const NOT_TEXT = /type=["'](checkbox|radio|range|file|color|hidden|button|submit|reset|image)["']/;
const FIELD = /<(input|textarea|select)\b(.*?)(\/>|<\/textarea>|<\/select>)/gs;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}
const files = ['app', 'components', 'contexts'].flatMap((d) => walk(join(ROOT, d), []));

interface Field { file: string; line: number; tag: string; attrs: string; source: string }
const fields: Field[] = files.flatMap((f) => {
  const source = readFileSync(f, 'utf8');
  return [...source.matchAll(FIELD)]
    .filter((m) => !NOT_TEXT.test(m[2]))
    .map((m) => ({ file: relative(ROOT, f), line: source.slice(0, m.index).split('\n').length, tag: m[1], attrs: m[2], source }));
});

/** Мелкий класс шрифта (без префикса md:/placeholder:): text-xs, text-sm, text-[Npx] и text-[Nrem] мельче 16 px. */
function smallFontClasses(attrs: string): string[] {
  const out: string[] = [];
  for (const m of attrs.matchAll(/(?<![\w[-])(?:[a-z0-9-]+:)*(text-(?:xs|sm|\[([\d.]+)(px|rem|em)\]))(?![\w-])/g)) {
    const [, cls, num, unit] = m;
    if (!num) { out.push(cls); continue; }
    const px = unit === 'px' ? Number(num) : Number(num) * 16;
    if (px < 16) out.push(cls);
  }
  return out;
}

/** `@media (pointer: coarse)` на верхнем уровне файла. */
const coarse = (root.nodes.filter((n) => n.type === 'atrule') as AtRule[])
  .filter((a) => a.name === 'media' && /\(\s*pointer:\s*coarse\s*\)/.test(a.params));

interface Sel { element: string; covers: string[]; fontSize: string; selector: string }
const selectors: Sel[] = coarse.flatMap((media) => {
  const out: Sel[] = [];
  media.walkRules((rule: Rule) => {
    const decl = rule.nodes.find((n) => n.type === 'decl' && n.prop === 'font-size');
    if (!decl || decl.type !== 'decl') return;
    for (const selector of rule.selectors) {
      const element = /^(input|textarea|select)\b/.exec(selector)?.[1];
      if (!element) continue;
      out.push({ element, covers: [...selector.matchAll(/\[class\*="([^"]+)"\]/g)].map((m) => m[1]), fontSize: decl.value, selector });
    }
  });
  return out;
});

describe('правило в CSS: поле на телефоне не мельче 16 px', () => {
  it('стоит под (pointer: coarse), вне @layer и после @tailwind utilities', () => {
    expect(coarse.length).toBeGreaterThan(0);
    const utilities = root.nodes.findIndex((n) => n.type === 'atrule' && (n as AtRule).name === 'tailwind' && (n as AtRule).params === 'utilities');
    expect(utilities).toBeGreaterThanOrEqual(0);
    for (const media of coarse) expect(root.nodes.indexOf(media)).toBeGreaterThan(utilities);
  });

  it('пол 16 px у поля без класса: шрифт родителя крупнее — остаётся, мельче — 16', () => {
    for (const element of ['input', 'textarea', 'select']) {
      const floor = selectors.filter((s) => s.element === element && s.covers.length === 0);
      expect(floor.map((s) => s.fontSize.replace(/\s+/g, ''))).toContain('max(16px,100%)');
    }
    // У input пол не трогает флажки и кнопки.
    const input = selectors.find((s) => s.element === 'input' && s.covers.length === 0)!;
    for (const type of ['checkbox', 'radio', 'submit', 'button']) expect(input.selector).toContain(`[type="${type}"]`);
  });

  it('каждый мелкий класс, что стоит сегодня на полях, получает 16 px у input, textarea и select', () => {
    const used = new Set(fields.flatMap((f) => smallFontClasses(f.attrs)));
    expect(used.size).toBeGreaterThan(0); // перепись нашла поля: пустой список зеленел бы всегда
    const missing: string[] = [];
    for (const cls of used) {
      for (const element of ['input', 'textarea', 'select']) {
        const ok = selectors.some((s) => s.element === element && s.covers.includes(cls) && parseFloat(s.fontSize) >= 16 && /px$/.test(s.fontSize.trim()));
        if (!ok) missing.push(`${element} ${cls}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('перепись мелкого класса не путает цвет с размером', () => {
    expect(smallFontClasses('className="text-[var(--text-primary)] text-sm md:text-xs text-[13px] text-[0.8rem] text-[18px] text-lg"'))
      .toEqual(['text-sm', 'text-xs', 'text-[13px]', 'text-[0.8rem]']);
  });
});

describe('правила полей и слоёв в DESIGN_SYSTEM.md называют то, что есть', () => {
  const ds = readFileSync(join(ROOT, '.claude/DESIGN_SYSTEM.md'), 'utf8');
  const section = /### Поля, слои и состояния[\s\S]*?(?=\n---)/.exec(ds)?.[0] ?? '';

  it('раздел на месте, и каждый адрес из него существует', () => {
    const paths = [...section.matchAll(/`((?:app|lib|hooks|tests)\/[^`\s]+\.(?:css|ts|tsx))`/g)].map((m) => m[1]);
    expect(paths).toContain('tests/unit/mobile-input-font.test.ts');
    expect(paths.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it('скилл vedar-design отсылает к разделу', () => {
    expect(readFileSync(join(ROOT, '.claude/skills/vedar-design/SKILL.md'), 'utf8')).toMatch(/«Поля,\s+слои и состояния»/);
  });
});

describe('запрет: шрифт поля в style={{}}', () => {
  /** Стиль поля: литерал в теге или объект из того же файла по имени. */
  function inlineFontSize(f: Field): boolean {
    if (/fontSize\s*:/.test(f.attrs)) return true;
    for (const m of f.attrs.matchAll(/style=\{\s*(?:\{\s*\.\.\.)?([A-Za-z_$][\w$]*)/g)) {
      const def = new RegExp(`(?:const|let)\\s+${m[1]}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(f.source);
      if (def && /fontSize\s*:/.test(def[1])) return true;
    }
    return false;
  }

  it('ни у одного поля ввода шрифт не задан в style — правило для телефона до него не дотянется', () => {
    expect(fields.filter(inlineFontSize).map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it('запрет видит и литерал, и общий объект стиля', () => {
    const source = 'const inputStyle = {\n  padding: 4,\n  fontSize: 14,\n};\n';
    expect(inlineFontSize({ file: 'x', line: 1, tag: 'input', attrs: ' style={{ fontSize: 13 }}', source })).toBe(true);
    expect(inlineFontSize({ file: 'x', line: 1, tag: 'input', attrs: ' style={inputStyle}', source })).toBe(true);
    expect(inlineFontSize({ file: 'x', line: 1, tag: 'textarea', attrs: " style={{ ...inputStyle, resize: 'none' }}", source })).toBe(true);
    expect(inlineFontSize({ file: 'x', line: 1, tag: 'input', attrs: ' className="text-sm" style={{ padding: 4 }}', source })).toBe(false);
  });
});
