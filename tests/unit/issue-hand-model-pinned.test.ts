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

const HANDS = [
  '.github/workflows/claude.yml',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/weekly-chronicle.yml',
] as const;

/**
 * События, которые claude-code-action понимает
 * (`src/github/context.ts`, замер по исходнику 06.09). `push` в списке НЕТ.
 */
const SUPPORTED_EVENTS = [
  'issues', 'issue_comment', 'pull_request', 'pull_request_review',
  'pull_request_review_comment', 'workflow_dispatch', 'repository_dispatch',
  'schedule', 'workflow_run',
] as const;

/**
 * Замороженное решение владельца. Меняется вместе с этим файлом.
 *
 * 06.09, вечер: Fable 5.1 → Opus 5 по разбору расходов. Цифра, на которой
 * принято решение: два прогона руки за сутки стоили $11.2, то есть ~$5.6 за
 * штуку — Fable вдвое дороже по обоим концам ($10/$50 против $5/$25).
 * Утреннее решение «модель должна быть fable 5.1» отменено тем же владельцем
 * в тот же день; записано так, чтобы через месяц не спорить, какое из двух
 * было последним.
 */
const PINNED = 'claude-opus-5';

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

/**
 * Замер 06.09: прогон 59 issue-triage умер за две секунды с
 * «Action failed with error: Unsupported event type: push». Так же молча
 * умирал бы всякий запуск маркером — и у летописца тоже. Маркер обязан
 * переводиться в workflow_dispatch, а шаг руки — не запускаться на push.
 */
describe('маркер не доезжает до руки напрямую', () => {
  for (const wf of HANDS) {
    const src = readFileSync(join(process.cwd(), wf), 'utf-8');
    if (!/^\s{2}push:/m.test(src)) continue;

    it(`${wf} — у push своя работа-переводчик в workflow_dispatch`, () => {
      expect(src).toMatch(/if: github\.event_name == 'push'/);
      expect(src).toMatch(/gh workflow run [\w.-]+\.yml/);
    });

    it(`${wf} — работа с рукой на push не запускается`, () => {
      expect(src).toMatch(/if: github\.event_name != 'push'/);
    });

    // Прогон 61: переводчик сработал, а рука отказала — «Workflow initiated
    // by non-human actor: github-actions (type: Bot)». Переводчик без этого
    // разрешения бесполезен: он рождает прогон, который отвергают.
    it(`${wf} — инициатор-бот переводчика разрешён поимённо, не звёздочкой`, () => {
      expect(src).toMatch(/allowed_bots: github-actions\s*$/m);
      expect(src).not.toMatch(/allowed_bots:\s*['"]?\*/);
    });
  }

  it('список поддерживаемых событий не содержит push — иначе перевод не нужен', () => {
    expect(SUPPORTED_EVENTS).not.toContain('push' as never);
  });
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
