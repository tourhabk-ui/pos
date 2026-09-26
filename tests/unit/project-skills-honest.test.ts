/**
 * Навыки проекта называют то, что есть на диске (правило 10.09: описание
 * живёт дольше кода, и читающий верит описанию).
 *
 * Навык — инструкция, которой Claude следует без проверки. Назови он файл,
 * которого нет, или сторожа, которого удалили, — следующая сессия пойдёт
 * по несуществующему пути или решит, что правило охраняется. Поэтому каждый
 * путь в обратных кавычках и каждый `tests/...` в навыках пяти рабочих
 * процессов обязан существовать.
 *
 * Там же — изъятые 26.09 навыки скрейпа: они учили писать в
 * agent_route_knowledge (VIEW, запрет §4.1) данными чужого сайта (решение
 * владельца 07.09).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS = ['money-path', 'pd-guard', 'pg-verify', 'role-audit', 'pr-drive'];
const ROOT = process.cwd();
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8');

function referencedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`((?:lib|app|components|tests|scripts|migrations|docs|\.github)\/[^`\s]+?)`/g)) {
    out.add(m[1]);
  }
  for (const m of text.matchAll(/(tests\/(?:unit|integration)\/[\w.-]+\.test\.tsx?)/g)) out.add(m[1]);
  return [...out].filter((p) => !/[<>*]/.test(p));
}

describe('навыки проекта ссылаются на существующее', () => {
  for (const name of SKILLS) {
    it(name, () => {
      const file = join(ROOT, '.claude/skills', name, 'SKILL.md');
      expect(existsSync(file), `нет навыка ${name}`).toBe(true);
      const text = readFileSync(file, 'utf-8');
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      const missing = referencedPaths(text).filter((p) => !existsSync(join(ROOT, p)));
      expect(missing, `${name} называет несуществующее`).toEqual([]);
      // Короткие имена в кавычках (`db-schema-doc`) — сторож, навык или job CI.
      const unresolved = [...text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)]
        .map((m) => m[1])
        .filter((t) => !existsSync(join(ROOT, 'tests/unit', `${t}.test.ts`))
          && !existsSync(join(ROOT, '.claude/skills', t))
          && !new RegExp(`^  ${t}:`, 'm').test(CI));
      expect(unresolved, `${name}: имя не найдено ни среди сторожей, ни среди навыков, ни в ci.yml`).toEqual([]);
    });
  }

  it('навыков скрейпа чужого сайта нет', () => {
    expect(existsSync(join(ROOT, '.claude/skills/web-scraper-routes.md'))).toBe(false);
    expect(existsSync(join(ROOT, '.claude/skills/json-route-parser.md'))).toBe(false);
  });
});
