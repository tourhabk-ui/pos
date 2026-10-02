/**
 * Один знак у платформы — силуэт Камчатки с иконки приложения.
 *
 * Решение владельца 30.09 («нашу иконку — чем не лого»). До этого знаков было
 * три, и все жили одновременно: горная ломаная в шапке (`Logo`), золотой вулкан
 * `logo-kamchatka.svg` в футере и в разметке schema.org, полуостров на иконке
 * и во вкладке. Поисковик показывал в карточке организации не то, что человек
 * видел на телефоне.
 *
 * Сторож держит связку: компонент рисует тот же контур, что лежит в мастер-файле;
 * футер и разметка берут его, а не старые файлы; старых файлов нет.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const pathOf = (svg: string) => svg.match(/<path[^>]*\sd="([^"]+)"/)?.[1] ?? null;

describe('знак Ведара — один', () => {
  it('компонент Logo рисует контур мастер-файла', () => {
    const master = pathOf(read('public/brand/vedar-mark.svg'));
    expect(master).not.toBeNull();
    const logo = read('components/shared/Logo.tsx');
    expect(logo).toContain(`d="${master}"`);
    expect(logo).toContain('viewBox="0 0 231 333"');
  });

  it('старых знаков нет ни файлом, ни ссылкой', () => {
    for (const f of ['public/logo-kamchatka.svg', 'public/logo-tourhub.svg']) {
      expect(existsSync(join(process.cwd(), f))).toBe(false);
    }
    for (const f of ['app/layout.tsx', 'components/layout/Footer.tsx', 'components/layout/Header.tsx']) {
      expect(read(f)).not.toMatch(/logo-kamchatka|logo-tourhub/);
    }
  });

  it('футер и шапка берут компонент, разметка для поисковиков — иконку', () => {
    expect(read('components/layout/Footer.tsx')).toMatch(/<Logo size=\{32\}/);
    expect(read('components/layout/Header.tsx')).toMatch(/<Logo size=\{28\} mono=\{onPhoto\} \/>/);
    // Рядом со знаком в шапке — слово (силуэт один читается хуже ломаной).
    expect(read('components/layout/Header.tsx')).toMatch(/fontFamily: 'var\(--font-playfair\)'[^>]*>Ведар</);
    const layout = read('app/layout.tsx');
    const logos = layout.match(/"logo": `\$\{BASE_URL\}[^`]+`/g) ?? [];
    expect(logos.length).toBeGreaterThan(0);
    for (const l of logos) expect(l).toContain('/icons/icon-512.png');
  });

  it('герой главной и экран маршрута — тот же знак, а не свой (02.10)', () => {
    // Владелец 02.10 «лого везде разный»: герой главной рисовал свой знак —
    // два вулкана и «Vedarai» (решение 01.08, пережившее решение 30.09), а
    // экран «На маршруте» вместо знака показывал домик.
    const home = read('app/_home/_HomeV8Client.tsx');
    expect(home).toMatch(/<div className="hero-brand">\s*<Logo size=\{30\} mono \/>/);
    expect(home).toMatch(/className="hb-word"[^>]*>Ведар</);
    expect(home).not.toMatch(/hb-mark|>Vedarai</);
    const field = read('app/planning/_PlanningClient.tsx');
    expect(field).toMatch(/aria-label="На главную"[\s\S]{0,400}<Logo size=\{26\} \/>/);
  });

  it('знак по умолчанию — цвет акцента, хардкода hex в компоненте нет', () => {
    const logo = read('components/shared/Logo.tsx');
    expect(logo).toContain("'var(--accent)'");
    expect(logo).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});
