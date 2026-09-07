// @vitest-environment node
/**
 * Перепись админ-панели 03.09, третья пара: «AI и автоматизации» и «Работа
 * Volcano OS» — одна страница.
 *
 * Обе отвечали на один вопрос владельца «жив ли агент»: первая — живостью
 * cron-агентов (agent_run_history) и ручным запуском, вторая — задачами и
 * событиями ядра (agent_tasks / agent_events). Таблицы разные, вопрос один;
 * две плитки в одном разделе меню на один вопрос — одна плитка.
 *
 * Сторож держит четыре вещи. Плитки «AI и автоматизации» в меню нет; старый
 * адрес не 404, а редирект на вкладку. Кокпит ядра остался ОТДЕЛЬНЫМ файлом
 * без мутаций — обёртка лишь переключает вкладки, кнопки ручного запуска
 * кронов живут во вкладке агентов (сторож `volcano-cockpit` держит
 * read-only кокпита буквально, по тексту файла; здесь — что обёртка это не
 * размывает). Вкладка берётся из адреса после монтирования.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LAYOUT = read('app/hub/admin/layout.tsx').replace(/^\s*\/\/.*$/gm, '');
const TABS = read('app/hub/admin/volcano/_VolcanoTabs.tsx');
const PAGE = read('app/hub/admin/volcano/page.tsx');
const CONFIG = read('next.config.js');

describe('«AI и автоматизации» больше не отдельная плитка', () => {
  it('в меню админки нет /hub/admin/agents, кокпит остался', () => {
    expect(LAYOUT).not.toMatch(/href:\s*'\/hub\/admin\/agents'/);
    expect(LAYOUT).toMatch(/href:\s*'\/hub\/admin\/volcano'/);
  });

  it('страницы /hub/admin/agents нет — есть редирект на вкладку', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/agents'))).toBe(false);
    expect(CONFIG).toMatch(/source:\s*'\/hub\/admin\/agents',\s*destination:\s*'\/hub\/admin\/volcano\?tab=agents'/);
  });

  it('клиент агентов живёт под volcano', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/volcano/_AgentsClient.tsx'))).toBe(true);
  });

  it('ссылки на снятый адрес ведут на вкладку', () => {
    // app/transparency снесён 05.09 (ископаемое совета директоров) — см.
    // tests/unit/transparency-removed.test.ts.
    for (const p of [
      'lib/agents/execution/initiative-executor.ts',
      'app/hub/admin/email/_EmailAdminClient.tsx',
    ]) {
      expect(read(p), p).not.toMatch(/\/hub\/admin\/agents(?!\/|\?)/);
    }
  });
});

describe('кокпит и агенты — вкладки, кокпит не размыт', () => {
  it('страница рендерит обёртку, обёртка — оба клиента', () => {
    expect(PAGE).toMatch(/import VolcanoTabs from '\.\/_VolcanoTabs'/);
    expect(TABS).toMatch(/import VolcanoClient from '\.\/_VolcanoClient'/);
    expect(TABS).toMatch(/import AgentsClient from '\.\/_AgentsClient'/);
    expect(TABS).toMatch(/tab === 'agents' \? <AgentsClient \/> : <VolcanoClient \/>/);
  });

  it('обёртка ничего не запрашивает сама — ни чтения, ни мутаций', () => {
    // Кокпит read-only по замыслу (модель автономии 27.08); обёртка не должна
    // стать тем местом, куда мутации просочатся мимо его сторожа.
    expect(TABS).not.toMatch(/fetch\(/);
    expect(TABS).not.toMatch(/\/api\//);
  });

  it('по умолчанию — ядро: адрес /hub/admin/volcano показывает то же, что раньше', () => {
    expect(TABS).toMatch(/useState<VolcanoTab>\('kernel'\)/);
    expect(TABS).toMatch(/return 'kernel';/);
  });

  it('вкладка берётся из адреса после монтирования — редирект открывает агентов', () => {
    expect(TABS).toMatch(/get\('tab'\) === 'agents'/);
    expect(TABS).toMatch(/useEffect\(\(\) => \{ setTab\(tabFromLocation\(\)\); \}, \[\]\)/);
    expect(TABS).toMatch(/window\.history\.replaceState/);
  });
});
