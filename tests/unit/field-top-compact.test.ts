/**
 * Сторож шага 1 «как у основных навигаторов» (владелец 26.09: «как можно ещё
 * сократить окна, чтоб маршрут работал как у основных навигаторов»).
 *
 * Верхняя плашка — одна строка прибора; «карта сохранена · условия»,
 * подложка и покрытие — по тапу. То, что ЗНАЧИТ беду, свёрнутым не бывает:
 * сбой карты и предупреждения видны всегда, предупреждение — непрозрачное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STRIP = readFileSync(join(process.cwd(), 'components/field/FieldStatusStrip.tsx'), 'utf8');
const SCREEN = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf8');

describe('верхняя плашка поля — одна строка', () => {
  it('строка данных свёрнута, пока её не раскрыли; вместо неё — значок с полной фразой', () => {
    expect(STRIP).toMatch(/const showData = p\.dataLine && \(!collapsible \|\| p\.expanded\)/);
    expect(STRIP).toMatch(/title=\{p\.dataLine\} aria-label=\{p\.dataLine\}/);
    expect(STRIP).toMatch(/aria-expanded=\{Boolean\(p\.expanded\)\}/);
  });

  it('экран поля передаёт свёртку; подложка и покрытие — только в раскрытой', () => {
    expect(SCREEN).toContain('onToggle={() => setStatusOpen(o => !o)}');
    expect(SCREEN).toContain("{statusOpen && mapPackBaseUrl && fieldBaseMap.kind === 'leaflet' && (");
    expect(SCREEN).toContain("{statusOpen && fieldBaseMap.kind === 'vedar' && coverageNote && (");
  });

  it('сбой карты свёрнутым не бывает', () => {
    expect(SCREEN).toContain("{fieldBaseMap.kind === 'vedar' && vedarDiag && (");
    expect(SCREEN).not.toContain("{statusOpen && fieldBaseMap.kind === 'vedar' && vedarDiag && (");
  });

  it('предупреждение — тоньше, но непрозрачное', () => {
    expect(SCREEN).toMatch(/mx-3 mt-1 rounded-xl px-3 py-1\.5 flex flex-col gap-1 text-\[12px\] leading-tight"\s*style=\{\{\s*background: 'var\(--bg-card\)'/);
  });
});

/**
 * Шаг 2 (владелец 26.09, «как у основных навигаторов»): свёрнутый лист — одна
 * строка с цифрой и кнопкой «+»; «Место / Трек / Наблюдение» — меню над
 * листом. Развёрнутый лист показывает панель как прежде.
 */
describe('свёрнутый лист — цифра и «+»', () => {
  it('панель под листом — только в развёрнутом', () => {
    expect(SCREEN).toContain('{(hasRoute || isLoadingRoute) && sheetOpen && (');
  });

  it('«+» — 56 px под палец, идущая запись видна на самой кнопке', () => {
    expect(SCREEN).toMatch(/onClick=\{\(\) => setActionsOpen\(o => !o\)\}/);
    expect(SCREEN).toMatch(/width: 56, height: 56/);
    expect(SCREEN).toMatch(/const running = collapsedActions\.find\(a => a\.active\)/);
    expect(SCREEN).toMatch(/\{running\?\.hint && !actionsOpen && \(/);
  });

  it('меню — те же действия, выбор закрывает меню, отказ виден', () => {
    expect(SCREEN).toMatch(/onPress: \(\) => \{ setActionsOpen\(false\); a\.onPress\(\); \}/);
    expect(SCREEN).toContain('<FieldActionBar actions={collapsedActions} error={fieldBarError ?? saveMapError} />');
  });

  it('отказ действия виден и в свёрнутом листе, без меню', () => {
    expect(SCREEN).toMatch(/\{\(fieldBarError \?\? saveMapError\) && !actionsOpen && \(/);
  });
});

describe('с экрана «На маршруте» есть выход домой (владелец 26.09)', () => {
  it('в полосе вкладок — ссылка на главную, 44 px', () => {
    expect(SCREEN).toMatch(/\{tab === 'trail' && \(\s*<Link href="\/" aria-label="На главную"/);
    expect(SCREEN).toMatch(/style=\{\{ width: 44, height: 44, color: 'var\(--text-secondary\)' \}\}/);
  });
});
