/**
 * Нижний лист экрана «На маршруте» свёрнут по умолчанию (02.09, карт-бланш
 * владельца: «экран не юзабелен» — компас и геройская карточка закрывали
 * карту с треком).
 *
 * Форма листа (владелец 02.09 08:18, «поправь форму»): одна непрозрачная
 * поверхность, ручка сверху, тело с прокруткой, панель действий прибита к
 * низу и видна всегда; кнопки масштаба — в приборном ряду у компаса, а не
 * под листом.
 *
 * Черты:
 *  1. По умолчанию лист свёрнут; выбор запоминается на телефоне.
 *  2. Панель действий — вне прокрутки, в обоих состояниях листа.
 *  3. Ручка — кнопка с именем и aria-expanded, видимая на поверхности.
 *  4. Поверхность листа непрозрачная (§2), вложенных карточек внутри нет.
 *  5. Масштаб карты — в приборном ряду, карта свои кнопки не рисует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
const DIST = readFileSync(join(process.cwd(), 'components/field/FieldDistance.tsx'), 'utf-8');
const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

const sheetAt = SRC.indexOf("fixed inset-x-0 bottom-0 z-10 flex flex-col rounded-t-2xl");
const sheetEnd = SRC.indexOf('{/* Конец bottom sheet', sheetAt);
const SHEET = SRC.slice(sheetAt, sheetEnd);

describe('нижний лист «На маршруте» свёрнут по умолчанию', () => {
  it('состояние sheetOpen начинается с false и читается с диска', () => {
    expect(SRC).toMatch(/const \[sheetOpen, setSheetOpen\] = useState\(false\)/);
    expect(SRC).toMatch(/localStorage\.getItem\(SHEET_OPEN_KEY\) === '1'/);
    expect(SRC).toMatch(/SHEET_OPEN_KEY = 'field_sheet_open_v\d+'/);
  });

  it('свёрнутый лист несёт компактную цифру и ничего лишнего', () => {
    const at = SRC.indexOf(') : !sheetOpen ? (');
    expect(at).toBeGreaterThan(0);
    // Конец свёрнутой ветки — начало развёрнутой (`) : (` + фрагмент).
    const compact = SRC.slice(at, SRC.indexOf(') : (\n        <>', at));
    expect(compact).toContain('<FieldDistance compact');
    // Своей рамки у строки нет — поверхность даёт лист (карточка в карточке запрещена).
    expect(compact).not.toContain("background: 'var(--bg-card)', border");
  });

  it('ручка — кнопка с именем и aria-expanded, видимая на поверхности', () => {
    expect(SRC).toMatch(/onClick=\{toggleSheet\}[\s\S]{0,200}aria-expanded=\{sheetOpen\}/);
    expect(SRC).toMatch(/aria-label=\{sheetOpen \? 'Свернуть приборы' : 'Развернуть приборы'\}/);
    // Пилюля цветом текста, не границы: --border на тёмной карте терялась (08:18).
    expect(SHEET).toMatch(/w-10 h-1 rounded-full" style=\{\{ background: 'var\(--text-muted\)' \}\}/);
    expect(SHEET).not.toMatch(/rounded-full" style=\{\{ background: 'var\(--border\)' \}\}/);
  });

  it('потолок листа зависит от состояния: свёрнут 32vh, развёрнут 60vh', () => {
    expect(SRC).toMatch(/sheetOpen \? 'max-h-\[60vh\]' : 'max-h-\[32vh\]'/);
  });

  it('FieldDistance умеет компактный вид с чипами в строку', () => {
    expect(DIST).toMatch(/compact\?: boolean/);
    expect(DIST).toMatch(/if \(p\.compact\)/);
  });
});

describe('форма листа (02.09 08:18)', () => {
  it('лист — непрозрачная поверхность из трёх частей: ручка, тело с прокруткой, панель', () => {
    expect(sheetAt).toBeGreaterThan(0);
    expect(SHEET).toMatch(/background: 'var\(--bg-card\)',\s*borderTop: '1px solid var\(--border\)'/);
    expect(SHEET).toContain('paddingBottom: \'env(safe-area-inset-bottom)\'');
    expect(SHEET).toContain('className="flex-1 min-h-0 overflow-y-auto overscroll-contain"');
    // Прокрутка — только у тела, не у всего листа.
    expect(SHEET).not.toMatch(/bottom-0 z-10 overflow-y-auto/);
  });

  it('панель действий прибита к низу листа и одна на оба состояния', () => {
    const footerAt = SHEET.lastIndexOf('<FieldActionBar actions={fieldActions} error={fieldBarError} />');
    expect(footerAt).toBeGreaterThan(0);
    const tail = SHEET.slice(SHEET.indexOf('{/* Конец тела листа. */}'));
    expect(tail).toContain('shrink-0 px-4 pt-2 pb-2 max-w-sm mx-auto w-full');
    expect(tail).toContain('<FieldActionBar actions={fieldActions} error={fieldBarError} />');
    // Внутри тела при маршруте панели нет: только в ветке без маршрута
    // (экран выбора цели) и в прибитом низу.
    const occurrences = SHEET.split('<FieldActionBar actions={fieldActions}').length - 1;
    expect(occurrences).toBe(2);
  });

  it('геройская цифра — на поверхности листа, без своей рамки; не крупнее 64px', () => {
    expect(SHEET).not.toMatch(/gap-4 w-full rounded-2xl p-4"\s*style=\{\{ background: 'var\(--bg-card\)'/);
    expect(DIST).toMatch(/fontSize: 'clamp\(44px, 15vw, 64px\)'/);
  });

  it('режим и «Сменить маршрут» — в одну строку', () => {
    expect(SHEET).toMatch(/mt-3 flex items-center justify-center gap-2 flex-wrap/);
  });

  it('масштаб карты — в приборном ряду у компаса, карта свои кнопки не рисует', () => {
    expect(SRC).toMatch(/<VedarZoomButtons handle=\{mapCtl\} \/>/);
    expect(SRC).toMatch(/showZoomButtons=\{showMap\}/);
    expect(SRC).toMatch(/onControls=\{setMapCtl\}/);
    expect(MAP).toMatch(/\{ready && showZoomButtons && \(/);
    // На середине высоты кнопки уходили под лист — угадывать высоту листа нельзя.
    expect(MAP).not.toMatch(/top: '50%'/);
  });
});
