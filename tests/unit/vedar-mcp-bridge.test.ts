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
import { externalBinary } from '../helpers/external-binary';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DIR = 'integrations/vedar-mcp-bridge';
const SCRIPT = `${DIR}/vedar_mcp_bridge.py`;
const WORKFLOW = '.github/workflows/china-bridge-probe.yml';
const MARKER = '.github/triggers/china-bridge-probe.json';

const manifest = JSON.parse(read('server.json')) as { remotes: Array<{ url: string }> };
const MCP_URL = manifest.remotes[0].url;

// Без python3 тесты моста прежде писали в лог и делали return — зелёные без
// проверки (аудит 15.10, W3-china, §4.0). Теперь вне CI — пропуск с причиной
// в имени теста, в CI — отказ.
const PY = externalBinary('python3');

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
    // Поля, которые мост модели не показывает (BRIDGE_HIDDEN_ARGS, 29.10:
    // notify_url — своего приёмника у моста нет), убираются тем же правилом.
    const hidden = new Set(pythonSet(src, 'BRIDGE_HIDDEN_ARGS'));
    expect([...hidden]).toEqual(['notify_url']);
    const withoutHidden = (schema: unknown) => {
      const copy = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, unknown>; required?: string[] };
      for (const h of hidden) delete copy.properties?.[h];
      if (copy.required) copy.required = copy.required.filter((r) => !hidden.has(r));
      return copy;
    };
    for (const live of PUBLIC_MCP_TOOLS) {
      const snap = byName.get(live.name);
      expect(snap?.description, `${live.name}: описание в снимке устарело`).toBe(live.description.trim().slice(0, 1024));
      expect(snap?.parameters, `${live.name}: параметры в снимке устарели`).toEqual(withoutHidden(live.inputSchema));
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

  it.skipIf(PY.skip)(PY.title('скрипт компилируется (python3 на раннере есть)'), () => {
    PY.require('компиляцию моста');
    expect(() => execFileSync('python3', ['-I', '-m', 'py_compile', join(ROOT, SCRIPT)], { stdio: 'pipe' })).not.toThrow();
  });

  it.skipIf(PY.skip)(PY.title('конструктор VedarMCP принимает и прежнее client_name: скачанный людьми код не падает'), () => {
    // 15.10 (CN-quick) параметр переименован в name, и внешний
    // VedarMCP(client_name=...) упал бы с TypeError (аудит 15.10, W3-china).
    // Конструктор в сеть не ходит — проверяется вызовом без MCP.
    PY.require('совместимость конструктора моста');
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'out = {',
      '  "old_kw": m.VedarMCP(client_name="my-agent").client_name,',
      '  "new_kw": m.VedarMCP(name="my-agent/qwen").client_name,',
      '  "positional": m.VedarMCP(m.MCP_URL, "pos-agent").client_name,',
      '  "default": m.VedarMCP().client_name,',
      '}',
      'try:',
      '    m.VedarMCP(name="a", client_name="b")',
      '    out["both"] = None',
      'except TypeError as e:',
      '    out["both"] = str(e)',
      'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'MCP_CLIENT_NAME'));
    const out = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', code], { env, encoding: 'utf-8' })) as Record<string, string | null>;
    expect(out.old_kw).toBe('my-agent');
    expect(out.new_kw).toBe('my-agent/qwen');
    // Второй позиционный — как и до переименования: имя клиента.
    expect(out.positional).toBe('pos-agent');
    expect(out.default).toBe('vedar-mcp-bridge');
    // Оба сразу — понятная ошибка, а не тихий выбор одного.
    expect(out.both).toMatch(/одним параметром — name/);
    expect(out.both).toMatch(/client_name/);
  });
});

describe('notify_url модели не отдаётся (29.10)', () => {
  it.skipIf(PY.skip)(PY.title('to_openai_tools прячет notify_url, вызов его вычищает: модель не выдумает адрес приёмника'), () => {
    PY.require('скрытые аргументы моста');
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'tool = {"name": "create_lead", "description": "x", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "notify_url": {"type": "string"}}, "required": ["name", "notify_url"]}}',
      'out = m.to_openai_tools([tool])[0]["function"]["parameters"]',
      'args = m.bridge_args({"name": "a", "notify_url": "https://evil.example-agent.ru/x"})',
      'sys.stdout.write(json.dumps({"props": sorted(out["properties"]), "required": out["required"], "args": args, "orig": sorted(tool["inputSchema"]["properties"])}))',
    ].join('\n');
    const out = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf-8' })) as { props: string[]; required: string[]; args: Record<string, string>; orig: string[] };
    expect(out.props).toEqual(['name']);
    expect(out.required).toEqual(['name']);
    expect(out.args).toEqual({ name: 'a' });
    // Схема сервера не мутируется — прячется копия.
    expect(out.orig).toEqual(['name', 'notify_url']);
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
