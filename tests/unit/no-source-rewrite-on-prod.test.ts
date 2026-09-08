/**
 * Никакой инструмент не переписывает исходники на проде.
 *
 * Находка аудита 08.09 (прогон 6). Инструмент «самоисцеления SQL» правил
 * `.ts`-файлы подстрочной заменой и сохранял их на диск. Три довода за
 * удаление, каждого хватило бы поодиночке:
 *
 * 1. ЯДРО УЖЕ ЗАПРЕЩАЛО ЭТО. `lib/agents/kernel/policy.ts`: «правка кода на
 *    проде мимо PR запрещена: код меняется только draft PR + merge человека».
 *    Запрет стоял на пути ядра, а `executeBoardTool` его не спрашивал —
 *    дверь заперли, окно оставили.
 *
 * 2. ЗАМЕНА БЕЗ ГРАНИЦ СЛОВА ЛОМАЛА ПРАВИЛЬНОЕ. В карте есть
 *    «WHERE status NOT IN» → «WHERE booking_status NOT IN», а в rescue-agency
 *    этой формой отбираются АКТИВНЫЕ SOS из `sos_events`, где колонки
 *    `booking_status` нет. Инструмент сломал бы сводку SOS — тот самый
 *    запрос, который накануне чинили, чтобы живой сигнал не терялся.
 *
 * 3. ДЕВЯТЬ ИЗ ОДИННАДЦАТИ целевых файлов удалены ещё в апреле.
 *
 * Сторож держит правило, а не этот случай: запись в файлы репозитория из
 * кода агентов запрещена целиком.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('агенты не пишут в исходники', () => {
  it('ни один файл под lib/agents не зовёт запись на диск', () => {
    const writers: string[] = [];
    for (const file of walk(join(ROOT, 'lib/agents'))) {
      const code = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
      if (/\bwriteFileSync\(|\bfs\.promises\.writeFile\(|\bappendFileSync\(/.test(code)) {
        writers.push(relative(ROOT, file).split('\\').join('/'));
      }
    }
    expect(
      writers,
      `правка кода на проде запрещена ядром, но эти пишут: ${writers.join(', ')}`,
    ).toEqual([]);
  });

  it('инструмента-переписывателя больше нет ни в реестре, ни в диспетчере', () => {
    const TOOLS = readFileSync('lib/agents/tools/board-executor-tools.ts', 'utf-8');
    // Разбор наверху файла его называет — запрещаем ВЫЗОВ, а не слово.
    expect(TOOLS).not.toMatch(/return fixSQLColumnErrors\(/);
    expect(TOOLS).not.toMatch(/^\s*'fixSQLColumnErrors',$/m);
  });

  it('исполнителя самоисцеления нет в реестре инициатив', () => {
    const EXEC = readFileSync('lib/agents/execution/initiative-executor.ts', 'utf-8');
    expect(EXEC).not.toMatch(/sql_query_fix:\s+executeSQLQueryFix/);
    expect(EXEC).not.toMatch(/^\s*'sql_query_fix',/m);
  });

  it('запрет ядра на месте — на нём и держится довод', () => {
    const POLICY = readFileSync('lib/agents/kernel/policy.ts', 'utf-8');
    expect(POLICY).toContain('правка кода на проде мимо PR запрещена');
  });
});

describe('права не выписаны мёртвым', () => {
  it('каждое агентство реестра прав существует на диске', async () => {
    // Здесь стояли шесть удалённых агентств, и двум из них был выписан
    // ПОЛНЫЙ доступ, включая правку схемы прода мимо миграций. Права
    // мёртвых не безобидны: имя приходит строкой, и подставивший её
    // получает то, чего не имеет никто живой.
    const { AGENCY_TOOL_SCOPE } = await import('@/lib/agents/tools/board-executor-tools');
    const missing = Object.keys(AGENCY_TOOL_SCOPE).filter((a) => {
      try { statSync(join(ROOT, 'lib/agents/agencies', `${a}.ts`)); return false; } catch { return true; }
    });
    expect(missing, `в реестре прав есть, на диске нет: ${missing.join(', ')}`).toEqual([]);
  });

  it('правка схемы прода не выписана никому', async () => {
    // CLAUDE.md: изменение схемы БД — только SQL-миграцией.
    const { AGENCY_TOOL_SCOPE } = await import('@/lib/agents/tools/board-executor-tools');
    for (const [agency, tools] of Object.entries(AGENCY_TOOL_SCOPE)) {
      expect(tools as string[], `${agency} может менять схему прода`).not.toContain('applySchemaFix');
    }
  });
});

describe('перепись SQL смотрит на существующие файлы', () => {
  const TOOLS = readFileSync('lib/agents/tools/board-executor-tools.ts', 'utf-8');
  const listed = [...TOOLS.matchAll(/^\s*'([a-z-]+-agency\.ts)',$/gm)].map((m) => m[1]);

  it('список непустой', () => {
    expect(listed.length).toBeGreaterThan(0);
  });

  it('каждый названный файл существует на диске', () => {
    // Перепись молча пропускала несуществующие, поэтому список выглядел
    // живым, а смотрел в пустоту: девять из одиннадцати удалены в апреле.
    const missing = listed.filter((f) => {
      try { statSync(join(ROOT, 'lib/agents/agencies', f)); return false; } catch { return true; }
    });
    expect(missing, `в списке переписи нет на диске: ${missing.join(', ')}`).toEqual([]);
  });
});
