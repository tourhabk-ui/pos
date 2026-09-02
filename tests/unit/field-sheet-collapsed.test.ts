/**
 * Нижний лист экрана «На маршруте» свёрнут по умолчанию (02.09, карт-бланш
 * владельца: «экран не юзабелен» — компас и геройская карточка закрывали
 * карту с треком).
 *
 * Черты:
 *  1. По умолчанию лист свёрнут; выбор запоминается на телефоне.
 *  2. В свёрнутом виде видны цифра с чипами И панель действий — запись
 *     трека и наблюдение не прячутся за ручкой.
 *  3. Ручка — кнопка с именем и aria-expanded, а не декоративная полоска.
 *  4. Главная цифра остаётся непрозрачной карточкой и в свёрнутом виде (§2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
const DIST = readFileSync(join(process.cwd(), 'components/field/FieldDistance.tsx'), 'utf-8');

describe('нижний лист «На маршруте» свёрнут по умолчанию', () => {
  it('состояние sheetOpen начинается с false и читается с диска', () => {
    expect(SRC).toMatch(/const \[sheetOpen, setSheetOpen\] = useState\(false\)/);
    expect(SRC).toMatch(/localStorage\.getItem\(SHEET_OPEN_KEY\) === '1'/);
    expect(SRC).toMatch(/SHEET_OPEN_KEY = 'field_sheet_open_v\d+'/);
  });

  it('свёрнутый лист несёт цифру и панель действий', () => {
    const at = SRC.indexOf(') : !sheetOpen ? (');
    expect(at).toBeGreaterThan(0);
    // Конец свёрнутой ветки — начало развёрнутой (`) : (` + фрагмент).
    const compact = SRC.slice(at, SRC.indexOf(') : (\n        <>', at));
    expect(compact).toContain('<FieldDistance compact');
    expect(compact).toContain('<FieldActionBar actions={fieldActions}');
    expect(compact, 'главная цифра — непрозрачная карточка').toContain("background: 'var(--bg-card)'");
  });

  it('ручка — кнопка с именем и aria-expanded', () => {
    expect(SRC).toMatch(/onClick=\{toggleSheet\}[\s\S]{0,200}aria-expanded=\{sheetOpen\}/);
    expect(SRC).toMatch(/aria-label=\{sheetOpen \? 'Свернуть приборы' : 'Развернуть приборы'\}/);
  });

  it('потолок листа зависит от состояния: свёрнут 32vh, развёрнут 60vh', () => {
    expect(SRC).toMatch(/sheetOpen \? 'max-h-\[60vh\]' : 'max-h-\[32vh\]'/);
  });

  it('FieldDistance умеет компактный вид с чипами в строку', () => {
    expect(DIST).toMatch(/compact\?: boolean/);
    expect(DIST).toMatch(/if \(p\.compact\)/);
  });
});
