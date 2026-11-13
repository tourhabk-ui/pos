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
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES, CHANGE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { chinaClientFamily, clientRegion, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';
import { externalBinary } from '../helpers/external-binary';
import { buildServerInstructions } from '@/lib/mcp/server-instructions';
import { ANSWER_RELAY_RULE } from '@/lib/mcp/request-status-schema';

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

  it.skipIf(PY.skip)(PY.title('отмена и перенос заявки: мост спрашивает человека у терминала, а где спросить некого — не вызывает'), () => {
    PY.require('ворота изменения заявки в мосте');
    // Набор — тот же, что у сервера: инструмент, меняющий заявку, не пройдёт мимо ворот.
    expect(pythonSet(src, 'CHANGE_TOOLS')).toEqual([...CHANGE_TOOL_NAMES].sort());
    for (const name of CHANGE_TOOL_NAMES) expect(pythonSet(src, 'WRITE_TOOLS')).not.toContain(name);
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'asked = []',
      'def yes(a):',
      '    asked.append(a.get("action")); return True',
      'def no(a):',
      '    asked.append(a.get("action")); return False',
      'cancel = {"key": "k", "action": "cancel"}',
      'out = {',
      '  "nobody": m.change_gate("change_request", cancel, None),',
      '  "refused": m.change_gate("change_request", cancel, no),',
      '  "confirmed": m.change_gate("change_request", {"key": "k", "action": "change_date", "date": "2027-07-18"}, yes),',
      '  "other_tool": m.change_gate("get_request_status", {"key": "k"}, None),',
      '  "asked": asked,',
      '}',
      'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const out = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf-8' })) as {
      nobody: string | null; refused: string | null; confirmed: string | null; other_tool: string | null; asked: string[];
    };
    // HTTP-режим и одиночный вопрос: человека у терминала нет — вызова нет, модели сказано почему.
    expect(out.nobody).toMatch(/только с подтверждением человека.*заявка не изменена/);
    expect(out.refused).toMatch(/не подтвердил — заявка не изменена/);
    expect(out.confirmed).toBeNull();
    expect(out.other_tool).toBeNull();
    // Спросили оба раза, когда было кого; без человека — не спрашивали.
    expect(out.asked).toEqual(['cancel', 'change_date']);
    // Ворота стоят в цикле вызовов, а спрашивающий есть только в интерактивном режиме.
    expect(src).toMatch(/refusal = change_gate\(fn, args, self\.confirm_change\)/);
    expect(src).toMatch(/def interactive\(agent\):\n(?:\s*#.*\n)*\s*agent\.confirm_change = confirm_change_at_terminal/);
    expect(src).toMatch(/self\.confirm_change = None/);
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
    // notify_url — своего приёмника у моста нет; 08.11: test — пробный прогон,
    // мост говорит с живым человеком), убираются тем же правилом.
    const hidden = new Set(pythonSet(src, 'BRIDGE_HIDDEN_ARGS'));
    expect([...hidden].sort()).toEqual(['notify_url', 'test']);
    const withoutHidden = (schema: unknown) => {
      const copy = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, unknown>; required?: string[] };
      for (const h of hidden) delete copy.properties?.[h];
      if (copy.required) copy.required = copy.required.filter((r) => !hidden.has(r));
      return copy;
    };
    // Предложения о скрытых полях мост из описания убирает (bridge_description):
    // модели не показано поле — не нужна и фраза о нём.
    const hiddenStripped = (text: string) => {
      const sentences = text.trim().split(/(?<=[.!?])\s+/);
      // Целым словом, как у моста: «test» не вырезает предложение с «latest».
      const kept = sentences.filter((s) => ![...hidden].some((h) => new RegExp(`\\b${h}\\b`).test(s)));
      return { kept, whole: kept.length === sentences.length ? text.trim() : kept.join(' ') };
    };
    const withoutHiddenSentences = (text: string) => {
      const { kept, whole } = hiddenStripped(text);
      if (whole.length <= 1024) return whole;
      // Не поместилось — целые предложения с конца, а не обрыв фразы (12.11).
      while (kept.length > 1 && kept.join(' ').length > 1024) kept.pop();
      return kept.join(' ').slice(0, 1024);
    };
    for (const live of PUBLIC_MCP_TOOLS) {
      const snap = byName.get(live.name);
      // Мост отбрасывает предложения с конца, а у пишущих инструментов последним
      // стоит правило о согласии: описание, которое не помещается, потеряло бы
      // его молча (замечание ревью #3314). Не помещается — сокращать описание.
      expect(
        hiddenStripped(live.description).whole.length,
        `${live.name}: описание не помещается в предел моста — последнее предложение будет отброшено; сократите описание`,
      ).toBeLessThanOrEqual(1024);
      expect(snap?.description, `${live.name}: описание в снимке устарело`).toBe(withoutHiddenSentences(live.description));
      expect(snap?.description, `${live.name}: фраза о скрытом поле осталась в снимке`).not.toMatch(/notify_url|\btest: true\b/);
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

  it.skipIf(PY.skip)(PY.title('снимок vedar_tools.json собирает сам мост: to_openai_tools по живому реестру даёт файл байт в байт, без фраз о notify_url'), () => {
    // TS-зеркало правила выше сверяет снимок с реестром, но производитель
    // снимка — Python. Здесь судит он сам: правка bridge_description без
    // пересборки файла (или наоборот) краснеет.
    PY.require('сборку снимка мостом');
    const tools = PUBLIC_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'tools = json.loads(sys.stdin.read())',
      'sys.stdout.write(json.dumps(m.to_openai_tools(tools), ensure_ascii=False, indent=2) + "\\n")',
    ].join('\n');
    const built = execFileSync('python3', ['-I', '-B', '-c', code], { input: JSON.stringify(tools), encoding: 'utf-8' });
    expect(built).toBe(read(`${DIR}/vedar_tools.json`));
    expect(built).not.toMatch(/notify_url/);
    // Фраза о согласии на ПД не отрезана обрезкой в 1024 знака.
    const booking = (JSON.parse(built) as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === 'create_booking_request');
    expect(booking?.function.description).toMatch(/согласие на их обработку и передай consent: true\.$/);
    // Отмена и перенос: описание помещается целиком (последняя фраза — о том, что передать человеку),
    // а поле пробы модели не показано — мост говорит с живым человеком.
    const change = (JSON.parse(built) as Array<{ function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }>).find((t) => t.function.name === 'change_request');
    expect(change?.function.description.length).toBeLessThanOrEqual(1024);
    expect(change?.function.description).toMatch(/кто узнал на деле \(told\) — передайте человеку как есть\.$/);
    expect(Object.keys(change?.function.parameters.properties ?? {}).sort()).toEqual(['action', 'date', 'key']);
    // Правило доставки ответа (план «после отказа», 2б) не отрезано тоже: в
    // первой редакции описание статуса вышло за 1024 знака, и мост обрывал
    // правило на «передайте человеку». Описание статуса помещается целиком —
    // кончается точкой своего последнего предложения, а не обрывом.
    const status = (JSON.parse(built) as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === 'get_request_status');
    expect(status?.function.description).toContain(ANSWER_RELAY_RULE);
    expect(status?.function.description.length).toBeLessThan(1024);
    expect(status?.function.description).toMatch(/бронь перенесена или заведена на другую дату\.$/);
    // Заявка на прокат (12.11): описание кончалось обрывом «Никогда не с» —
    // ровно 1024 знака посреди правила о согласии. Теперь помещается целиком.
    const rental = (JSON.parse(built) as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === 'create_car_rental_request');
    expect(rental?.function.description.length).toBeLessThan(1024);
    expect(rental?.function.description).toMatch(/Никогда не ставь consent: true сам, без ответа человека\.$/);
  });

  it('ни одно описание в снимке не кончается обрывом фразы', () => {
    const snapshot = JSON.parse(read(`${DIR}/vedar_tools.json`)) as Array<{ function: { name: string; description: string } }>;
    expect(snapshot.length).toBeGreaterThan(20);
    for (const t of snapshot) {
      const d = t.function.description;
      expect(d.length, `${t.function.name}: длиннее предела`).toBeLessThanOrEqual(1024);
      // Конец предложения — точка, знак или закрывающая скобка/кавычка после них.
      expect(d, `${t.function.name}: описание оборвано посреди фразы`).toMatch(/[.!?][»")]?$/);
    }
  });

  it('обрезка моста идёт по границе предложения, а не по знаку', () => {
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'texts = json.loads(sys.stdin.read())',
      'sys.stdout.write(json.dumps([m.bridge_description(t) for t in texts], ensure_ascii=False))',
    ].join('\n');
    const first = `${'А'.repeat(600)}.`;
    const second = `${'Б'.repeat(300)}.`;
    const third = `${'В'.repeat(300)}!`;
    const out = JSON.parse(execFileSync('python3', ['-I', '-B', '-c', code], {
      input: JSON.stringify([
        `${first} ${second} ${third}`,          // три предложения, третье не помещается
        `${first} ${second}`,                   // помещается целиком
        `${'Г'.repeat(2000)}.`,                 // одно предложение длиннее предела
        `${first} Скрытое поле notify_url сюда не идёт. ${second} ${third}`,
      ]),
      encoding: 'utf-8',
    })) as string[];
    expect(out[0]).toBe(`${first} ${second}`);
    expect(out[1]).toBe(`${first} ${second}`);
    // Резать больше негде — жёсткий предел остаётся страховкой.
    expect(out[2]).toHaveLength(1024);
    // Сначала уходят предложения о скрытых полях, потом — хвост по границе.
    expect(out[3]).toBe(`${first} ${second}`);
  });
});

describe('инструкция сервера из initialize доходит до модели (30.10)', () => {
  // Мост держал свою копию правил платформы, и в ней безусловно стояло
  // строка о прямой оплате — а у сервера оплата тура по выключателю.
  // Теперь системный промпт = правила моста + поле instructions из initialize.
  // Судит вызов: Agent собирается на подложенном _post (сеть не нужна),
  // initialize отдаёт настоящий текст buildServerInstructions.
  const runAgent = (instructions: string | null) => {
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, SCRIPT))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'instr = json.loads(sys.stdin.read())',
      'def fake_post(url, payload, headers, timeout=None):',
      '    method = payload.get("method")',
      '    if method == "initialize":',
      '        res = {"serverInfo": {"name": "vedar", "version": "t"}}',
      '        if instr is not None:',
      '            res["instructions"] = instr',
      '        return {"result": res}',
      '    if method == "tools/list":',
      '        return {"result": {"tools": [{"name": "get_tours", "description": "x", "inputSchema": {"type": "object", "properties": {}}}]}}',
      '    raise RuntimeError("неожиданный вызов " + str(method))',
      'm._post = fake_post',
      'agent = m.Agent({"provider": "deepseek", "base_url": "http://x", "model": "x", "key": "k"})',
      'sys.stdout.write(json.dumps({"system": agent.history[0]["content"], "role": agent.history[0]["role"]}, ensure_ascii=False))',
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-I', '-B', '-c', code], { input: JSON.stringify(instructions), encoding: 'utf-8' })) as { system: string; role: string };
  };

  it.skipIf(PY.skip)(PY.title('системный промпт агента содержит instructions сервера целиком — при обоих положениях выключателя оплаты'), () => {
    PY.require('системный промпт моста');
    for (const acceptsPayments of [false, true]) {
      const instr = buildServerInstructions({ acceptsPayments });
      const out = runAgent(instr);
      expect(out.role).toBe('system');
      expect(out.system).toContain(instr);
      // Свои правила моста остались: ворота согласия и порядок вызовов безопасности.
      expect(out.system).toMatch(/согласен на обработку данных/);
      expect(out.system).toMatch(/safety_status/);
      // Слова об оплате — только сервера: ровно его правило, своего у моста нет.
      const paymentLines = out.system.split('\n').filter((l) => /оплат/i.test(l));
      expect(paymentLines.length, `оплата в промпте: ${paymentLines.join(' | ')}`).toBe(1);
      expect(instr).toContain(paymentLines[0]);
    }
  });

  it.skipIf(PY.skip)(PY.title('без instructions от сервера — общие правила моста, и ни слова об оплате'), () => {
    PY.require('системный промпт моста без инструкции');
    for (const instr of [null, '', '   ']) {
      const out = runAgent(instr);
      expect(out.system).toMatch(/Данные бери ТОЛЬКО из инструментов/);
      expect(out.system).toMatch(/112/);
      expect(out.system).not.toMatch(/оплат/i);
      expect(out.system).not.toMatch(/Инструкция сервера/);
    }
  });

  it('безусловной строки об оплате в мосту нет', () => {
    // Запрет по исходнику: оплата — дело сервера и его выключателя.
    expect(read(SCRIPT)).not.toMatch(/оплата идёт напрямую/);
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
