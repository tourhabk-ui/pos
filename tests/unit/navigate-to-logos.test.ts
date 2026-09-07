/**
 * Внешние навигаторы — марками на кнопках (владелец 06.09: «уменьшить
 * внешние карты, просто логотипом на кнопке»). Сторож держит:
 *   - у каждого приложения есть файл марки в public, и он существует;
 *   - слово состояния («Маршрут в» / «Показать в») не пропало с кнопок в
 *     никуда: оно стоит перед рядом и в aria-label каждой кнопки;
 *   - кнопка — цель 44 пикселя, марка без текста рядом;
 *   - карточка точки и лист «На маршруте» зовут компактный режим.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_ICONS, NAV_LABELS, navLinks } from '@/lib/navigation/handoff';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('марки навигаторов', () => {
  it('у каждого приложения есть файл марки, и он лежит в public', () => {
    for (const app of Object.keys(NAV_LABELS) as Array<keyof typeof NAV_ICONS>) {
      const icon = NAV_ICONS[app];
      expect(icon.startsWith('/images/nav/')).toBe(true);
      expect(existsSync(join(ROOT, 'public', icon))).toBe(true);
      const svg = read(join('public', icon));
      expect(svg).toContain('<svg');
      expect(svg).toContain('role="img"');
    }
  });

  it('navLinks отдаёт марку вместе со ссылкой', () => {
    const links = navLinks({ lat: 53.0195, lng: 158.6483 }, { lat: 52.8857, lng: 158.704 });
    expect(links).toHaveLength(4);
    for (const l of links) expect(l.icon).toBe(NAV_ICONS[l.app]);
  });
});

describe('NavigateTo — кнопка-марка', () => {
  const NAV = read('components/shared/NavigateTo.tsx');

  it('слово состояния одно на ряд и в aria-label каждой кнопки', () => {
    expect(NAV).toMatch(/const verb = routing \? 'Маршрут в' : 'Показать в'/);
    expect(NAV).toMatch(/<span className=\{`\$\{captionClass\} mr-1`\}>\{verb\}<\/span>/);
    expect(NAV).toMatch(/aria-label=\{`\$\{verb\} \$\{l\.label\}`\}/);
  });

  it('цель 44 пикселя, внутри только марка без подписи', () => {
    expect(NAV).toMatch(/style=\{\{ width: 44, height: 44 \}\}/);
    expect(NAV).toMatch(/<img src=\{l\.icon\} alt=""/);
    expect(NAV).not.toContain('`Маршрут в ${l.label}`}\n');
  });

  it('compact прячет сноску и запрос геолокации', () => {
    expect(NAV).toMatch(/\{compact \? null : \(<>/);
  });

  it('карточка точки — компактно поверх стекла; лист «На маршруте» — компактно', () => {
    const card = read('components/field/PointCard.tsx');
    expect(card).toMatch(/<NavigateTo to=\{\{ lat: point\.lat, lng: point\.lng, name: title \}\}[\s\S]{0,200}compact tone="glass"/);
    const trail = read('app/planning/_PlanningClient.tsx');
    expect(trail).toMatch(/title="Проложить дорогу до точки"\s+compact/);
  });
});
