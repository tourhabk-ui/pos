// @vitest-environment node
/**
 * Перепись админ-панели 03.09, четвёртая пара: «Модели эволюции» и
 * «Health-метрики» — одна страница.
 *
 * Обе отвечали на один вопрос «кто сейчас отвечает»: Health-метрики пробуют
 * провайдеров ИИ настоящим запросом по кнопке, «Модели эволюции» опрашивают
 * у тех же провайдеров /v1/models и показывают, какая модель годна
 * решателю. Две плитки в разных разделах меню на один вопрос — одна плитка.
 *
 * Сторож держит: плитки «Модели эволюции» в меню нет; старый адрес не 404,
 * а редирект на вкладку; клиент моделей живёт под health и рендерится
 * вкладкой; вкладка берётся из адреса после монтирования; по умолчанию —
 * метрики, то есть адрес /hub/admin/health показывает то же, что раньше.
 * Проба провайдеров по-прежнему по кнопке (сторож census-block-d).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LAYOUT = read('app/hub/admin/layout.tsx').replace(/^\s*\/\/.*$/gm, '');
const TABS = read('app/hub/admin/health/_HealthTabs.tsx');
const PAGE = read('app/hub/admin/health/page.tsx');
const CONFIG = read('next.config.js');

describe('«Модели эволюции» больше не отдельная плитка', () => {
  it('в меню админки нет /hub/admin/evo/models, Health-метрики остались', () => {
    expect(LAYOUT).not.toMatch(/href:\s*'\/hub\/admin\/evo\/models'/);
    expect(LAYOUT).toMatch(/href:\s*'\/hub\/admin\/health'/);
  });

  it('страницы /hub/admin/evo/models нет — есть редирект на вкладку', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/evo'))).toBe(false);
    expect(CONFIG).toMatch(/source:\s*'\/hub\/admin\/evo\/models',\s*destination:\s*'\/hub\/admin\/health\?tab=models'/);
  });

  it('клиент моделей живёт под health', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/health/_ModelsClient.tsx'))).toBe(true);
  });
});

describe('метрики и модели — вкладки одной страницы', () => {
  it('страница рендерит обёртку, обёртка — оба клиента', () => {
    expect(PAGE).toMatch(/import HealthTabs from '\.\/_HealthTabs'/);
    expect(TABS).toMatch(/import HealthDashboardClient from '\.\/_HealthDashboardClient'/);
    expect(TABS).toMatch(/import ModelsClient from '\.\/_ModelsClient'/);
    expect(TABS).toMatch(/tab === 'models' \? <ModelsClient \/> : <HealthDashboardClient \/>/);
  });

  it('обёртка ничего не запрашивает сама', () => {
    expect(TABS).not.toMatch(/fetch\(/);
    expect(TABS).not.toMatch(/\/api\//);
  });

  it('по умолчанию — метрики: адрес /hub/admin/health показывает то же, что раньше', () => {
    expect(TABS).toMatch(/useState<HealthTab>\('metrics'\)/);
    expect(TABS).toMatch(/return 'metrics';/);
  });

  it('вкладка берётся из адреса после монтирования — редирект открывает модели', () => {
    expect(TABS).toMatch(/get\('tab'\) === 'models'/);
    expect(TABS).toMatch(/useEffect\(\(\) => \{ setTab\(tabFromLocation\(\)\); \}, \[\]\)/);
    expect(TABS).toMatch(/window\.history\.replaceState/);
  });
});
