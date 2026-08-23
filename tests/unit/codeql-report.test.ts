/**
 * Сторож разбора CodeQL: находка, которую нельзя прочитать, — не находка.
 *
 * 23.08.2026 в репозитории висели три алерта CodeQL (один высокий), и достать
 * их было нечем. Security-таб отвечает токену агента `403 Resource not
 * accessible by integration`, артефакт прогона лежит на blob-хранилище за
 * сетевой политикой, а Summary через API не читается. Проверка шла, деньги за
 * минуты раннера тратились, галочка была зелёной — и содержание знал ровно
 * один человек, глазами, в браузере.
 *
 * Здесь закреплены три исхода разбора (§4.0) и то, что уровень находки не
 * выдумывается: у CodeQL «высокая» приходит числом `security-severity`, а не
 * словом, и подставить вместо отсутствующего числа «низкая» значило бы тихо
 * разжаловать непонятую находку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const report = require_(join(process.cwd(), 'scripts/codeql-report.js')) as {
  severityOf: (r: unknown, rules: Map<string, unknown>) => { label: string; rank: number; score: number | null };
  placeOf: (r: unknown) => string | null;
  findingsOf: (s: unknown) => Array<{ ruleId: string; place: string | null; severity: string; rank: number }>;
  render: (f: unknown[]) => string;
  sarifFilesIn: (d: string) => string[];
};

const WF = readFileSync(join(process.cwd(), '.github/workflows/codeql.yml'), 'utf8');

const sarif = (results: unknown[], rules: unknown[] = []) => ({
  runs: [{ tool: { driver: { rules } }, results }],
});

const result = (ruleId: string, extra: Record<string, unknown> = {}) => ({
  ruleId,
  message: { text: 'непроверенный ввод доходит до запроса' },
  locations: [{
    physicalLocation: {
      artifactLocation: { uri: 'app/api/x/route.ts' },
      region: { startLine: 42 },
    },
  }],
  ...extra,
});

describe('уровень находки берётся из данных, а не выдумывается', () => {
  const rules = (severity: string) => new Map([
    ['js/sqli', { id: 'js/sqli', properties: { 'security-severity': severity } }],
  ]);

  it('высокая различается от средней по числу CodeQL', () => {
    expect(report.severityOf({ ruleId: 'js/sqli' }, rules('7.5')).label).toBe('высокая');
    expect(report.severityOf({ ruleId: 'js/sqli' }, rules('5.0')).label).toBe('средняя');
    expect(report.severityOf({ ruleId: 'js/sqli' }, rules('9.8')).label).toBe('критическая');
  });

  it('нет ни числа, ни level — так и сказано, а не «низкая»', () => {
    // Тихое разжалование непонятой находки — ровно тот случай, когда место
    // без исхода «не знаю» заполняется удобным ответом.
    const sev = report.severityOf({ ruleId: 'нет-такого' }, new Map());
    expect(sev.label).toBe('уровень не указан');
    expect(sev.rank).toBe(0);
  });

  it('при отсутствии числа берётся level правила', () => {
    const m = new Map([['js/x', { id: 'js/x', defaultConfiguration: { level: 'error' } }]]);
    expect(report.severityOf({ ruleId: 'js/x' }, m).label).toBe('ошибка');
  });
});

describe('место находки', () => {
  it('файл и строка складываются в кликабельный адрес', () => {
    expect(report.placeOf(result('js/sqli'))).toBe('app/api/x/route.ts:42');
  });

  it('места нет — null, а не выдуманная первая строка', () => {
    expect(report.placeOf({ ruleId: 'js/x' })).toBeNull();
  });
});

describe('три исхода разбора', () => {
  it('находки есть — перечислены поимённо, с файлом и строкой', () => {
    const f = report.findingsOf(sarif(
      [result('js/sqli'), result('js/xss')],
      [{ id: 'js/sqli', properties: { 'security-severity': '8.8' }, shortDescription: { text: 'SQL-инъекция' } }],
    ));
    expect(f).toHaveLength(2);
    const text = report.render(f);
    expect(text).toContain('js/sqli');
    expect(text).toContain('app/api/x/route.ts:42');
    expect(text).toContain('высокая');
    // Порядок: сначала опасное. Отчёт читают сверху.
    expect(f[0].ruleId).toBe('js/sqli');
  });

  it('таблица не разъезжается от находки со слешем и трубой', () => {
    // Первая же находка нового разбора была на нём самом:
    // js/incomplete-sanitization — экранирование трубы не трогало обратный
    // слеш, и `a\\|b` из текста находки ломал столбцы. Порядок замен важен.
    const f = report.findingsOf(sarif([result('js/x', { message: { text: 'a\\|b | c' } })]));
    const row = report.render(f).split('\n').find((l: string) => l.includes('js/x'))!;
    // Разделитель markdown — труба БЕЗ обратного слеша перед ней; ровно так
    // строку читает рендерер. Наивный split('|') считал бы и экранированные.
    expect(row.split(/(?<!\\)\|/), 'столбцов должно остаться ровно четыре').toHaveLength(6);
    expect(row, 'слеш из текста находки обязан быть экранирован').toContain('a\\\\');
  });

  it('находок нет — сказано вслух', () => {
    const text = report.render(report.findingsOf(sarif([])));
    expect(text).toMatch(/Находок нет/);
    expect(text, 'пустой отчёт неотличим от несработавшего шага').not.toBe('');
  });

  it('прочитать нечего — это отдельный исход, а не «находок нет»', () => {
    // Каталог без SARIF: шаг обязан краснеть. Скрипт возвращает пустой список
    // файлов, а `main` на нём выходит с кодом 1 — проверено ниже по коду.
    const empty = mkdtempSync(join(tmpdir(), 'cq-'));
    expect(report.sarifFilesIn(empty)).toEqual([]);
    const SRC = readFileSync(join(process.cwd(), 'scripts/codeql-report.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(SRC).toMatch(/files\.length === 0[\s\S]{0,200}process\.exit\(1\)/);
  });

  it('битый SARIF — тоже отказ, а не пустой отчёт', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-'));
    mkdirSync(join(dir, 'r'));
    writeFileSync(join(dir, 'r', 'javascript.sarif'), '{не json');
    expect(report.sarifFilesIn(join(dir, 'r'))).toHaveLength(1);
    const SRC = readFileSync(join(process.cwd(), 'scripts/codeql-report.js'), 'utf8');
    expect(SRC).toMatch(/не разбирается/);
  });
});

describe('ссылки внутри текста находки разрешаются в адреса', () => {
  it('«[here](1)» превращается в файл и строку', () => {
    // Без этого сообщение нечитаемо ровно там, где важнее всего: «here» без
    // «где» не отвечает ни на что. Поймано 23.08.2026 на находках самого
    // разбора — две штуки, и объяснить их было нечем.
    const f = report.findingsOf({
      runs: [{
        tool: { driver: { rules: [] } },
        results: [{
          ruleId: 'js/x',
          message: { text: 'used as a regular expression [here](1)' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'tests/a.ts' }, region: { startLine: 75 } } }],
          relatedLocations: [{ physicalLocation: { artifactLocation: { uri: 'lib/b.ts' }, region: { startLine: 12 } } }],
        }],
      }],
    }) as Array<{ message: string }>;
    expect(f[0].message).toBe('used as a regular expression here (lib/b.ts:12)');
  });

  it('ссылка без связанного места остаётся как была, а не теряется', () => {
    const f = report.findingsOf({
      runs: [{
        tool: { driver: { rules: [] } },
        results: [{
          ruleId: 'js/x',
          message: { text: 'смотри [сюда](3)' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
        }],
      }],
    }) as Array<{ message: string }>;
    expect(f[0].message).toBe('смотри [сюда](3)');
  });
});

describe('workflow действительно зовёт разбор', () => {
  it('SARIF остаётся на диске', () => {
    expect(WF).toMatch(/output:\s*sarif-results/);
  });

  it('разбор идёт всегда, даже когда анализ упал', () => {
    const step = WF.slice(WF.indexOf('codeql-report.js') - 400);
    expect(step).toMatch(/if:\s*always\(\)/);
    expect(WF).toMatch(/node scripts\/codeql-report\.js sarif-results/);
  });

  it('загрузка в Security-таб не отключена — двери две, а не одна', () => {
    // `upload: false` оставил бы историю алертов и дедупликацию без источника.
    expect(WF).not.toMatch(/upload:\s*false/);
  });
});
