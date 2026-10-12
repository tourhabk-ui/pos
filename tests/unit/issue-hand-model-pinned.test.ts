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
 *
 * С вечера 12.10 руки считают ТОКЕНОМ ПОДПИСКИ из репозиторного секрета
 * `CLAUDE_CODE_OAUTH_TOKEN` (вход `claude_code_oauth_token`) — решение
 * владельца «Подписка, бесплатно» после разбора #2396. Утром того же дня
 * руки переводились на ключ `ANTHROPIC_API_KEY` («проверь, может не нужно
 * переключать, если есть 238 $»; проба `anthropic-path-probe` 18: ключ
 * принят) — и это было полдела: ключ принимался на любой обычный запрос и
 * отвергался на каждый запрос руки.
 *
 * Причина нашлась в документации Anthropic, а не в ключе: 238 $ — месячные
 * кредиты плана Max, которые по странице api-credits-for-subscribers
 * покрывают API, Agent SDK и playground, но НЕ Claude Code; купленного
 * баланса 0. Проба 22 (12.10) показала, по чему сервер узнаёт Claude Code:
 * бета-заголовок `claude-code-20250219` ИЛИ user-agent `claude-cli` — по
 * одному достаточно, модель и путь не играют. Токен подписки платит планом,
 * не балансом (docs/authentication: «This token authenticates with your
 * Claude subscription»).
 *
 * История, чтобы не ходить по кругу (#2396): `ANTHROPIC_API_KEY` с 09.09
 * отвечал 401 «API key is invalid» (каждая замена до 08.10 включительно);
 * `CLAUDE_CODE_OAUTH_TOKEN` образца 10.09 отвечал ошибками организации
 * Console — 400 «Credit balance is too low» (13.09–04.10), затем «not scoped
 * to a workspace» (11–12.10): выдан, по всей видимости, под организацией
 * Console на шаге авторизации; новый токен авторизуется аккаунтом с Max.
 * Второй источник авторизации рядом не держим — и не только ради читаемого
 * отказа: по docs/authentication ключ `ANTHROPIC_API_KEY` СТАРШЕ токена, и
 * в неинтерактивном режиме (-p) «the key is always used when present», то
 * есть ключ рядом молча вернул бы руку на баланс Console.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HANDS = [
  '.github/workflows/claude.yml',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/weekly-chronicle.yml',
  // Свипер — та же рука на том же экшене и том же ключе; до 12.10 он
  // держался здесь только сторожем цены (agent-run-cost-guard), а ключ у
  // него никто не проверял.
  '.github/workflows/ci-sweeper.yml',
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

    it(`${wf} — считает токеном подписки из секрета раннера, не ключом Console`, () => {
      expect(src).toMatch(/^\s*claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/m);
    });

    it(`${wf} — ключ Console рядом с токеном не задан`, () => {
      // Незакомментированная строка `anthropic_api_key:` — второй источник
      // авторизации, и не равноправный: по старшинству ключ победил бы токен,
      // и рука молча вернулась бы на баланс Console (-p: «the key is always
      // used when present»). Та же проверка — на env ANTHROPIC_API_KEY у шага.
      expect(src).not.toMatch(/^\s*anthropic_api_key:/m);
      expect(src).not.toMatch(/^\s*ANTHROPIC_API_KEY:/m);
    });

    it(`${wf} — модель одна на весь файл, второй головы нет`, () => {
      // Комментарии не в счёт: у свипера «--model» стоит и в пояснении,
      // почему модель прибита. Судится код, а не слово.
      const code = src.replace(/^[ \t]*#.*$/gm, '');
      expect(code.match(/--model /g) ?? []).toHaveLength(1);
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
