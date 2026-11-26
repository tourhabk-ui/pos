/**
 * Разрешения сессий в .claude/settings.json — без дверей на любой код, сеть и
 * окружение (проверка безопасности ИИ-части 26.11, слово владельца «чини Карт
 * бланш»).
 *
 * Строка в `permissions.allow` пускает команду без вопроса человеку. До этого
 * дня там стояли `python3:*`, `node --env-file=.env.local:*`, `env`,
 * `curl -s *`, `git :*` и `npm :*`. Сессия, прочитавшая подсунутый текст
 * (issue, комментарий бота, страницу), могла без вопроса исполнить любой код,
 * напечатать секреты окружения, отправить их наружу или переписать историю
 * (`git push --force`, `git reset --hard`). Чтение и проверки остались, всё
 * остальное снова спрашивает.
 *
 * Это запрет, поэтому сторож сверяет строки файла (CLAUDE.md §4, 13.10):
 * список запрещённого — ниже, с причиной у каждой строки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(join(process.cwd(), '.claude/settings.json'), 'utf-8')) as {
  permissions?: { allow?: unknown };
};
const allow = Array.isArray(settings.permissions?.allow) ? (settings.permissions!.allow as string[]) : [];

/** Что пускает без вопроса: голова команды внутри Bash(...). */
const bashHeads = allow
  .filter((r) => r.startsWith('Bash(') && r.endsWith(')'))
  .map((r) => r.slice(5, -1).trim());

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /^\*$/, why: 'любая команда' },
  { re: /^(python3?|node|bash|sh|zsh|deno|bun|perl|ruby)\b(?! --version)/, why: 'интерпретатор — любой код' },
  { re: /^env\b|^printenv\b|^set\b|^export\b/, why: 'печать окружения с секретами' },
  { re: /--env-file/, why: 'секреты .env.local в процесс' },
  { re: /^(curl|wget|nc|ncat|ssh|scp|rsync)\b/, why: 'сеть наружу' },
  { re: /^git\s*(:|\*)/, why: 'любая команда git, вплоть до push --force и reset --hard' },
  { re: /^git (push|reset|rebase|commit|checkout|clean|config|remote)\b/, why: 'запись истории или настроек git' },
  { re: /^npm\s*(:|\*)/, why: 'любая команда npm, вплоть до publish и exec' },
  { re: /^(npx|npm exec)\s*(:|\*)/, why: 'любой пакет из сети' },
  { re: /^(rm|chmod|chown|sudo|dd)\b/, why: 'удаление и права' },
];

describe('разрешения сессий без вопроса', () => {
  it('список разрешений прочитан и не пуст', () => {
    expect(bashHeads.length).toBeGreaterThan(0);
  });

  for (const { re, why } of FORBIDDEN) {
    it(`нет разрешения: ${why}`, () => {
      const hits = bashHeads.filter((h) => re.test(h));
      expect(hits, `в .claude/settings.json разрешено без вопроса: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('проверки и чтение по-прежнему без вопроса', () => {
    for (const need of ['npx tsc:*', 'npx vitest:*', 'git status:*', 'git diff:*', 'git log:*']) {
      expect(bashHeads, need).toContain(need);
    }
  });

  it('сторож узнаёт снятые 26.11 строки', () => {
    const removed = ['python3:*', 'node --env-file=.env.local:*', 'env', 'curl -s *', 'curl -s --max-time *', 'git :*', 'npm :*'];
    for (const r of removed) {
      expect(FORBIDDEN.some(({ re }) => re.test(r)), r).toBe(true);
    }
  });
});
