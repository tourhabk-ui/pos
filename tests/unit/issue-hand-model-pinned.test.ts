// @vitest-environment node
/**
 * Рука, которая берёт issues в работу, называет свою модель вслух
 * (решение владельца 06.09).
 *
 * До этого дня ни `claude.yml`, ни `issue-triage.yml` модель не задавали:
 * action брал СВОЮ по умолчанию, и какая именно голова разбирала тикет,
 * из репозитория выяснить было нельзя. Это ровно третье состояние §4.0 в
 * запрещённом виде: «не знаю» выдавалось за «всё в порядке» — раны шли
 * зелёными, а чем они считали, не знал никто.
 *
 * Значение — решение владельца, а не деталь реализации. Меняется вместе с
 * этим сторожем одним коммитом: замороженная строка тем и полезна, что
 * молчаливый дрейф ключа/модели краснит сборку.
 *
 * Ключ отдельно: обе руки считают на раннере GitHub, значит платит секрет
 * репозитория (§8, таблица двух ключей). Переменная приложения Timeweb сюда
 * не относится — путать их уже стоило вечера.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HANDS = ['.github/workflows/claude.yml', '.github/workflows/issue-triage.yml'] as const;

/** Замороженное решение владельца. Меняется вместе с этим файлом. */
const PINNED = 'claude-fable-5-1';

describe('модель руки задана явно', () => {
  for (const wf of HANDS) {
    const src = readFileSync(join(process.cwd(), wf), 'utf-8');

    it(`${wf} — модель в claude_args, а не по умолчанию action`, () => {
      expect(src).toContain(`--model ${PINNED}`);
    });

    it(`${wf} — считает ключом раннера, а не переменной прода`, () => {
      expect(src).toMatch(/anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    });

    it(`${wf} — модель одна на весь файл, второй головы нет`, () => {
      expect(src.match(/--model /g) ?? []).toHaveLength(1);
    });
  }
});

describe('issues владельца берутся в работу без маркеров', () => {
  const src = readFileSync(join(process.cwd(), '.github/workflows/claude.yml'), 'utf-8');

  it('автор OWNER/MEMBER/COLLABORATOR запускает конвейер сам по себе', () => {
    expect(src).toMatch(/author_association/);
    expect(src).toMatch(/"OWNER", "MEMBER", "COLLABORATOR"/);
  });

  it('лейбл ночного триажа по-прежнему второй вход', () => {
    expect(src).toMatch(/github\.event\.label\.name == 'agent-proposal'/);
  });
});
