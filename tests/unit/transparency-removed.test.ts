// @vitest-environment node
/**
 * Transparency Hub снесён (05.09, решение владельца).
 *
 * Страница /transparency (только для админа, вопреки слову «публично» в
 * своей шапке) показывала 13 «директоров» AI-совета, удалённого в апреле,
 * с захардкоженными моделями («Юрист на GPT-4o Mini», «Спасатель на LLaMA
 * 3.3 70B»), которых нет ни в одном решателе, и зелёными точками
 * «активен за 7 дней», которые зажигал крон сводки спроса, пишущий в память
 * под ископаемыми id. Лента «решений» читала agent_approvals, куда с апреля
 * не пишет ни одна строка кода. Telegram-команды /approve_ и /reject_
 * одобряли то, чего не бывает.
 *
 * Живая правда про агентов — /hub/admin/volcano?tab=agents (реестр кронов,
 * журнал прогонов, эффекты ядра). Второй витрины с выдуманными фактами быть
 * не должно (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('страницы и её API больше нет', () => {
  it('файлы удалены', () => {
    expect(existsSync(join(ROOT, 'app/transparency'))).toBe(false);
    expect(existsSync(join(ROOT, 'app/api/public/transparency'))).toBe(false);
  });

  it('админ-меню на неё не ссылается', () => {
    expect(read('app/hub/admin/layout.tsx')).not.toMatch(/href:\s*'\/transparency'/);
  });
});

describe('Telegram не предлагает одобрять то, чего не бывает', () => {
  const WEBHOOK = read('app/api/telegram/webhook/route.ts');

  it('команд /approve_ и /reject_ нет ни в коде, ни в подсказке', () => {
    expect(WEBHOOK).not.toMatch(/\/approve_/);
    expect(WEBHOOK).not.toMatch(/\/reject_/);
  });

  it('вебхук не тянет ApprovalRequired', () => {
    expect(WEBHOOK).not.toMatch(/safeguards\/approval-required/);
  });
});
