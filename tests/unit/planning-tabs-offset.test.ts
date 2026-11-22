/**
 * /planning (22.11): видимый H1 вкладки «Подготовка» уезжал под шапку и
 * липкую полосу вкладок. Шапка — fixed высотой var(--header-h): у вкладки с
 * шапкой отступ сверху на её высоту, полоса липнет ровно под ней (не 56px).
 * Замер Playwright на проде (390 и 1280 px): было H1 71px при низе полосы
 * 103px; с правкой H1 135px, низ полосы 111px.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf8');

describe('/planning: вкладка не под шапкой', () => {
  it('отступ на высоту шапки и полоса вкладок липнет под ней', () => {
    expect(src).toContain("style={tab === 'planning' ? { paddingTop: 'var(--header-h)' } : undefined}");
    expect(src).toContain("top: tab === 'planning' ? 'var(--header-h)' : 0");
    expect(src).not.toContain('top-[56px]');
  });
});
