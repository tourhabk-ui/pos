// @vitest-environment node
/**
 * Перепись админ-панели 03.09, вторая пара: «Разведка» и Volcano Brain —
 * одна страница.
 *
 * Обе читали одну таблицу agent_memory: Brain показывал ленту памяти целиком,
 * «Разведка» — те же строки с ключами intelligence_*. Два входа на один
 * источник в одном разделе меню — один инструмент, показанный дважды
 * (владелец: «смотри сколько AI-инструментов, что дублируется?»).
 *
 * Сторож держит: плитки «Разведка» в меню нет; старый адрес не 404, а редирект
 * на вкладку; у Brain есть вкладка intel, она берётся из адреса после
 * монтирования; клиент разведки переехал без переписывания (его собственные
 * сторожа — intelligence-actions, intel-monitor-bridge — читают новый путь).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LAYOUT = read('app/hub/admin/layout.tsx').replace(/^\s*\/\/.*$/gm, '');
const BRAIN = read('app/hub/admin/brain/_BrainClient.tsx');
const CONFIG = read('next.config.js');

describe('«Разведка» больше не отдельная плитка', () => {
  it('в меню админки нет /hub/admin/intelligence', () => {
    expect(LAYOUT).not.toMatch(/href:\s*'\/hub\/admin\/intelligence'/);
  });

  it('страницы /hub/admin/intelligence нет — есть редирект на вкладку', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/intelligence/page.tsx'))).toBe(false);
    expect(CONFIG).toMatch(/source:\s*'\/hub\/admin\/intelligence',\s*destination:\s*'\/hub\/admin\/brain\?tab=intel'/);
  });

  it('клиент разведки живёт под brain, старого каталога нет', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/brain/_IntelligenceClient.tsx'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'app/hub/admin/intelligence'))).toBe(false);
  });
});

describe('Brain — разведка вкладкой на той же agent_memory', () => {
  it('рендерит клиент разведки вкладкой intel', () => {
    expect(BRAIN).toMatch(/import IntelligenceClient from '\.\/_IntelligenceClient'/);
    expect(BRAIN).toMatch(/tab === 'intel' && <IntelligenceClient \/>/);
    expect(BRAIN).toMatch(/id: 'intel', label: 'Разведка'/);
  });

  it('вкладка берётся из адреса после монтирования — редирект открывает нужную', () => {
    // В эффекте, не при рендере: на сервере window нет, и SSR-разметка
    // разошлась бы с клиентской.
    const effect = BRAIN.slice(BRAIN.indexOf("get('tab') === 'intel'") - 200, BRAIN.indexOf("get('tab') === 'intel'"));
    expect(effect).toMatch(/useEffect/);
    expect(BRAIN).toMatch(/get\('tab'\) === 'intel'\) setTab\('intel'\)/);
  });
});
