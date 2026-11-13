/**
 * Сторож: рутина сессии остаётся на Sonnet.
 *
 * Решение владельца 19.09 («переведи рутину на sonnet») по счёту Anthropic
 * за месяц: $114.92, из них 70% — КЭШ ($49.96 запись + $30.51 чтение), а не
 * работа моделей (выход $18.73). Запись в кэш дороже обычного входа и
 * платится заново, когда контекст главной сессии подрос. Значит дешевеет не
 * от смены модели самой по себе, а от того, что подметание и вычитывание
 * уходят в субагента со своим контекстом.
 *
 * ── Почему сторож держит СВЯЗКУ, а не приколотую модель ──────────────────
 *
 * `model: sonnet` во фронтматтере — объявление. Субагент, которого никто не
 * зовёт, экономит ноль и при этом выглядит сделанной работой (§10.09).
 * Поэтому проверяется и другая половина: правило в CLAUDE.md, которое велит
 * им пользоваться, и ссылка на каждого субагента по имени.
 *
 * ── Почему проверяется «только читают» ───────────────────────────────────
 *
 * Дешёвая модель с правом писать — не экономия, а другой риск. Правку делает
 * тот, кто отвечает за неё перед владельцем; субагент называет факт.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CLAUDE_MD = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/** Субагенты рутины: имя файла → как на него ссылается правило. */
const ROUTINE_AGENTS = ['poisk', 'razbor-vyvoda'] as const;

/** Правки делает главная сессия — этих инструментов у рутины быть не может. */
const WRITING_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

function agentFile(name: string): string {
  return join(ROOT, '.claude/agents', `${name}.md`);
}

function frontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

describe('субагенты рутины существуют и приколоты к Sonnet', () => {
  for (const name of ROUTINE_AGENTS) {
    it(`${name}: файл есть, model: sonnet`, () => {
      expect(existsSync(agentFile(name)), `нет .claude/agents/${name}.md`).toBe(true);
      const fm = frontmatter(readFileSync(agentFile(name), 'utf8'));
      // Без явной модели субагент наследует модель главной сессии — то есть
      // флагман, и вся экономия исчезает молча.
      expect(fm.model, `${name}: модель не задана`).toBe('sonnet');
      expect(fm.name, `${name}: имя во фронтматтере не совпадает с файлом`).toBe(name);
    });

    it(`${name}: ничего не правит`, () => {
      const fm = frontmatter(readFileSync(agentFile(name), 'utf8'));
      const tools = (fm.tools ?? '').split(',').map((t) => t.trim());
      expect(tools.length, `${name}: инструменты не перечислены — значит даны ВСЕ`).toBeGreaterThan(0);
      for (const forbidden of WRITING_TOOLS) {
        expect(tools, `${name}: ${forbidden} у дешёвой модели`).not.toContain(forbidden);
      }
    });
  }
});

describe('правило, которое их зовёт', () => {
  it('CLAUDE.md называет каждого субагента по имени', () => {
    // Половина связки. Приколотая модель без правила — конфиг в никуда.
    for (const name of ROUTINE_AGENTS) {
      expect(CLAUDE_MD, `CLAUDE.md не упоминает ${name}`).toContain(name);
    }
  });

  it('правило названо и ведёт к этому сторожу', () => {
    expect(CLAUDE_MD).toContain('Рутина сессии — на Sonnet');
    expect(CLAUDE_MD).toContain('routine-on-sonnet');
  });

  it('граница названа: решение и безопасность остаются на флагмане', () => {
    // Без этой половины правило читается как «всё на Sonnet», а сэкономить
    // на решении — не экономия.
    const at = CLAUDE_MD.indexOf('Рутина сессии — на Sonnet');
    const block = CLAUDE_MD.slice(at, at + 2600);
    expect(block).toContain('безопасности');
    expect(block).toMatch(/Сэкономить на решении — не экономия/);
  });

  it('повод записан числами, а не «стало дорого»', () => {
    // Правило без замера через месяц нечем ни подтвердить, ни отменить.
    const at = CLAUDE_MD.indexOf('Рутина сессии — на Sonnet');
    const block = CLAUDE_MD.slice(at, at + 2600);
    expect(block).toContain('$114.92');
    expect(block).toContain('$49.96');
  });
});

/**
 * Слово владельца 13.11: скилл разбора кабинета роли и команда параллельной
 * разработки велели помощникам писать код — первый раздавал пакеты правок по
 * копиям репозитория, вторая запускала двух агентов «верни только код». Это
 * расходилось с правилом выше, и тексты приведены к нему.
 *
 * Стиль инструкции сторож судить не умеет. Это запрет («этого быть не
 * должно»): три оборота, которыми работа над кодом отдавалась помощнику, не
 * возвращаются ни в одну команду и ни в один рабочий скилл проекта. Новую
 * формулировку той же мысли он не поймает — это названо, а не скрыто.
 */
describe('инструкции не отдают помощнику правку кода', () => {
  const COMMANDS_DIR = join(ROOT, '.claude/commands');
  const SKILLS_DIR = join(ROOT, '.claude/skills');
  const files: string[] = [
    ...readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md')).map((n) => `.claude/commands/${n}`),
    ...readdirSync(SKILLS_DIR)
      .filter((n) => existsSync(join(SKILLS_DIR, n, 'SKILL.md')))
      .map((n) => `.claude/skills/${n}/SKILL.md`),
  ];

  /** Обороты, которыми правка отдавалась помощнику. */
  const HANDS_CODE_TO_HELPER: Array<[RegExp, string]> = [
    [/верни только код/i, 'помощнику велено вернуть код'],
    [/субагент\S*\s+в\s+своих\s+worktree/i, 'пакеты правок розданы помощникам по копиям репозитория'],
    [/коммит в своей ветке\.?\s+Не пушить/i, 'помощнику велено коммитить в своей ветке'],
  ];

  it('команды и скиллы прочитаны', () => {
    // Пустой обход — отказ, а не «нарушений нет».
    expect(files.filter((f) => f.startsWith('.claude/commands/')).length).toBeGreaterThan(5);
    expect(files.filter((f) => f.startsWith('.claude/skills/')).length).toBeGreaterThan(5);
  });

  it('ни одна команда и ни один скилл не велит помощнику писать код', () => {
    const found: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const [re, what] of HANDS_CODE_TO_HELPER) {
        if (re.test(src)) found.push(`${f}: ${what}`);
      }
    }
    expect(found, 'правку делает главная сессия (CLAUDE.md §5.1)').toEqual([]);
  });

  it('оба приведённых текста называют правило, которому следуют', () => {
    for (const f of ['.claude/skills/role-audit/SKILL.md', '.claude/commands/parallel-dev.md']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} не ссылается на CLAUDE.md §5.1`).toContain('§5.1');
      expect(src, `${f} не говорит, кто пишет код`).toMatch(/главн\S+ сесси/i);
    }
  });

  it('у помощников поиска и разбора по-прежнему нет права писать', () => {
    // Вторая половина связки: текст «помощник только читает» держится тем,
    // что писать ему нечем. Проверяется выше по каждому; здесь — что список
    // помощников рутины не разошёлся с каталогом.
    const defined = readdirSync(join(ROOT, '.claude/agents')).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).sort();
    expect(defined).toEqual([...ROUTINE_AGENTS].sort());
  });
});
