/**
 * Сторож моста «любой LLM с OpenAI-совместимым API → MCP Ведара»
 * (integrations/vedar-mcp-bridge, скрипт владельца, 13.10: «мой скрипт,
 * LLM_API_KEY + LLM_MODEL и погнали»).
 *
 * Мост — отдельная программа на Python без зависимостей; из TypeScript её не
 * вызвать, но всё, что она ОБЕЩАЕТ о платформе, проверяется по платформе:
 * адрес MCP — из server.json; четыре пишущих инструмента, которым мост ставит
 * ворота согласия, — те же, что WRITE_TOOL_NAMES сервера; снимок схемы
 * vedar_tools.json — имена живых публичных инструментов; имя клиента с
 * провайдером — распознаётся реестром КНР журнала. Прогон с живой китайской
 * моделью делает workflow china-bridge-probe.yml с раннера (ключи DeepSeek и
 * DashScope лежат в секретах репозитория), не этот тест.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { chinaClientFamily, clientRegion, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DIR = 'integrations/vedar-mcp-bridge';
const SCRIPT = `${DIR}/vedar_mcp_bridge.py`;
const WORKFLOW = '.github/workflows/china-bridge-probe.yml';
const MARKER = '.github/triggers/china-bridge-probe.json';

const manifest = JSON.parse(read('server.json')) as { remotes: Array<{ url: string }> };
const MCP_URL = manifest.remotes[0].url;

/** Множество из `WRITE_TOOLS = { "a", "b" }` в исходнике моста. */
function pythonSet(src: string, name: string): string[] {
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`${name} не найден`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

describe('мост обещает о платформе только то, что есть', () => {
  const src = read(SCRIPT);

  it('адрес MCP по умолчанию — из server.json, а не свой', () => {
    expect(src).toContain(`"https://vedarai.ru/api/mcp"`);
    expect(MCP_URL).toBe('https://vedarai.ru/api/mcp');
  });

  it('ворота согласия стоят ровно на четырёх пишущих инструментах сервера', () => {
    expect(pythonSet(src, 'WRITE_TOOLS')).toEqual([...WRITE_TOOL_NAMES].sort());
    // Ворота — поведение: без consent заявка не уходит, модели говорят спросить человека.
    expect(src).toMatch(/if fn in WRITE_TOOLS and not args\.get\("consent"\)/);
  });

  it('снимок схемы vedar_tools.json — имена живых публичных инструментов, формат OpenAI function', () => {
    const snapshot = JSON.parse(read(`${DIR}/vedar_tools.json`)) as Array<{ type: string; function: { name: string; parameters: { type: string } } }>;
    expect(snapshot.map((t) => t.function.name).sort()).toEqual(PUBLIC_MCP_TOOLS.map((t) => t.name).sort());
    for (const t of snapshot) {
      expect(t.type).toBe('function');
      expect(t.function.parameters.type).toBe('object');
    }
  });

  it('снимок совпадает с живой схемой целиком — описание и параметры, а не только имена', () => {
    // 13.10 search_transfers стал прайсом машины целиком, а снимок ещё
    // продавал «свободные места» с окном дат: сторож по именам этого не видел.
    // Пересобрать: python3 vedar_mcp_bridge.py --schema vedar_tools.json
    // (to_openai_tools: описание обрезается до 1024 знаков, схема — как есть).
    const snapshot = JSON.parse(read(`${DIR}/vedar_tools.json`)) as Array<{ function: { name: string; description: string; parameters: unknown } }>;
    const byName = new Map(snapshot.map((t) => [t.function.name, t.function]));
    for (const live of PUBLIC_MCP_TOOLS) {
      const snap = byName.get(live.name);
      expect(snap?.description, `${live.name}: описание в снимке устарело`).toBe(live.description.trim().slice(0, 1024));
      expect(snap?.parameters, `${live.name}: параметры в снимке устарели`).toEqual(live.inputSchema);
    }
  });

  it('имя клиента несёт провайдера, и журнал относит его к семейству модели', () => {
    // Сборку имени мостом (client_name, база из MCP_CLIENT_NAME) с 15.10
    // проверяет вызов в china-quick.test.ts; здесь — как журнал его читает.
    expect(chinaClientFamily('vedar-mcp-bridge/deepseek')).toBe('deepseek');
    expect(chinaClientFamily('vedar-mcp-bridge/qwen')).toBe('qwen-code');
    expect(clientRegion('vedar-mcp-bridge/moonshot')).toBe(CHINA_REGION_LABEL);
    // Без провайдера (служебные режимы --tools, --call) — обычный клиент, не КНР.
    expect(clientRegion('vedar-mcp-bridge')).toBeNull();
  });

  it('ревизия протокола — Streamable HTTP, из поддерживаемых сервером; снятой модели DeepSeek нет', () => {
    expect(src).toMatch(/"protocolVersion": "2025-03-26"/);
    expect(src).not.toMatch(/"model": "deepseek-chat"/);
  });

  it('скрипт компилируется (python3 на раннере есть)', () => {
    let python: string | null = 'python3';
    try { execFileSync(python, ['--version'], { stdio: 'ignore' }); } catch { python = null; }
    if (!python) { console.error('[vedar-mcp-bridge] python3 не найден — компиляцию не проверить'); return; }
    expect(() => execFileSync(python as string, ['-I', '-m', 'py_compile', join(ROOT, SCRIPT)], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('прогон с живой китайской моделью — с раннера, по маркеру', () => {
  it('workflow зовёт мост с ключами DeepSeek и DashScope из секретов и красит job без вызова инструмента', () => {
    expect(existsSync(join(ROOT, WORKFLOW))).toBe(true);
    const wf = read(WORKFLOW);
    expect(wf).toContain(MARKER);
    expect(wf).toContain('vedar_mcp_bridge.py');
    expect(wf).toContain('secrets.DEEPSEEK_API_KEY');
    expect(wf).toContain('secrets.DASHSCOPE_API_KEY');
    // Ключи моделей — только раннеру; на прод они не ездят, секрет прода мосту не подключается.
    expect(wf).not.toContain('secrets.CRON_SECRET');
    // Ответ без единого вызова инструмента — не «подключили», а красный с причиной.
    expect(wf).toMatch(/инструмент/);
    const marker = JSON.parse(read(MARKER)) as { run: number; run1_reason: string };
    expect(marker.run).toBeGreaterThanOrEqual(1);
    expect(marker.run1_reason.length).toBeGreaterThan(20);
  });
});
