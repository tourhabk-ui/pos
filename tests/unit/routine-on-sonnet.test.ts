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
import { readFileSync, existsSync } from 'node:fs';
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
