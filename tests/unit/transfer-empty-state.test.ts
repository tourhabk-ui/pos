/**
 * Виджет трансферов: пустой результат — честный экран, не молчание (№2, 02.08).
 *
 * Жалоба Ярослава (как турист): искал трансфер → 0 расписаний → виджет молча
 * показывал пустоту, будто платформа сломана. Раньше блок результатов рендерился
 * только при `searchResults.length > 0`, а нулевой случай не обрабатывался.
 * Теперь: флаг `searched`, а при 0 результатах — блок с путём (другая дата /
 * планировщик с Кузьмичом). Это сторож исходника, чтобы дедэнд не вернулся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'components/transfer-operator/TransferSearchWidget.tsx'),
  'utf-8',
);

describe('пустой поиск трансферов ведёт к пути, а не в тупик', () => {
  it('есть состояние searched, отличающее «не искали» от «нашли 0»', () => {
    expect(src.includes('searched')).toBe(true);
    expect(src.includes('setSearched(true)')).toBe(true);
  });
  it('пустой результат рендерит честный экран (searched && ... length === 0)', () => {
    expect(src).toMatch(/searched[\s\S]{0,80}searchResults\.length === 0/);
    expect(src.includes('Прямых трансферов по этому запросу не нашлось')).toBe(true);
  });
  it('пустой экран даёт путь в планировщик с Кузьмичом', () => {
    expect(src.includes('href="/planner"')).toBe(true);
    expect(src.includes('Спланировать с Кузьмичом')).toBe(true);
  });
});
