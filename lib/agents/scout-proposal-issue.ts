/**
 * lib/agents/scout-proposal-issue.ts — задача GitHub из предложения разведки.
 *
 * Чистый модуль: без базы и сети, чтобы правило судилось вызовом.
 *
 * Зачем он отдельный (аудит агентов 23.11). Предложение разведки строится из
 * выжимок чужих лент — RSS, Telegram, X. До этого дня задача по нему
 * заводилась с меткой `agent-proposal` и строкой «@claude Реализуй», и рука
 * (`.github/workflows/claude.yml`) стартовала сама: агент с правом записи в
 * репозиторий получал задание, в котором человек не участвовал ни разу.
 * У находок эволюции такой выключатель есть с 08.08 (`EVO_AUTOPR`), у
 * разведки его не было.
 *
 * Теперь рука по предложению разведки стартует сама только при
 * `SCOUT_AUTOPR=1` (переменная окружения приложения). Без неё задача
 * заводится и ждёт человека: поставил метку `agent-proposal` — рука пошла.
 * Три двери руки закрыты разом:
 *   - метки `agent-proposal` на задаче нет;
 *   - упоминания руки в теле нет — ни нашего, ни пришедшего в тексте модели;
 *   - пометка в теле говорит `claude.yml` не брать задачу только за то, что
 *     её завёл токен владельца.
 */

/** То, что нужно задаче от предложения. */
export interface ProposalForIssue {
  title: string;
  why: string;
  files_to_change: string[];
  implementation_steps: string[];
  acceptance_criteria: string[];
  complexity: string;
  category: string;
}

/** Метка, по которой рука берёт задачу (`claude.yml`). */
export const HAND_LABEL = 'agent-proposal';

/** Метка всех предложений разведки: по ней идёт дедуп; руку она не запускает. */
export const SCOUT_PROPOSAL_LABEL = 'scout-proposal';

/**
 * Пометка в теле задачи. `claude.yml` по ней не запускает руку на событии
 * «задачу открыл владелец»: задачу открыл не человек, а его токен.
 */
export const SCOUT_PROPOSAL_MARKER = '<!-- scout-proposal -->';

/** Запускать ли руку по предложению сразу. Не задано — нет. */
export function scoutAutoPrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SCOUT_AUTOPR ?? '').trim() === '1';
}

/**
 * Текст модели руку не зовёт: «@claude» в нём становится словом «claude».
 * Иначе фраза из чужой статьи, пересказанная моделью, запускала бы руку
 * в обход выключателя.
 */
export function withoutHandMention(text: string): string {
  return text.replace(/@(?=claude)/gi, '');
}

export interface ProposalIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Задача по предложению. `autoRun` — рука стартует сама: метка руки и
 * упоминание в теле. Без него задача ждёт человека, и это сказано в теле.
 */
export function buildProposalIssue(
  p: ProposalForIssue,
  opts: { dateKey: string; uncheckedReason: string | null; autoRun: boolean },
): ProposalIssue {
  const clean = withoutHandMention;
  const files = p.files_to_change.map(clean);
  const task = [
    `Реализуй это предложение. Ограничься файлами: ${files.join(', ')} (если нужен ещё файл — обоснуй в PR, не трогай защищённые: middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos).`,
    'Definition of done — все критерии приёмки из этой задачи выполнены и проверяемы.',
    "Обязательно по CLAUDE.md: TypeScript strict (unknown + type guards, без any), все цвета — CSS vars, SQL только параметризованный ($1,$2) и import { pool } from '@/lib/db-pool', таблицы operator_bookings (booking_status) / operator_tours / v_kamchatka_routes_api (не устаревшие bookings и tours, не прямой выбор из kamchatka_routes), Zod-валидация входных данных API и JWT на защищённых роутах, AI только через callAIWaterfall/callAIFast, без отладочного console-вывода в продакшн-коде, без эмодзи в коде/UI/логах, новая миграция — следующий свободный номер, идемпотентная.",
    // Полный набор руке запрещён её же инструкцией (claude.yml): шесть минут и
    // весь вывод в контексте, а CI прогонит то же на PR. До 23.11 задача
    // требовала полный прогон — два задания противоречили друг другу.
    'Перед завершением: npx tsc --noEmit (0 ошибок) и целевые тесты — npx vitest run по затронутым файлам; полный набор прогонит CI. Оформи изменения как PR, не пушь напрямую в main.',
  ].join('\n');

  const body = [
    SCOUT_PROPOSAL_MARKER,
    // Непроверенное предложение обязано выглядеть иначе, чем прошедшее ревью:
    // человек в очереди читает первым делом верх тела.
    opts.uncheckedReason
      ? `> **Критик НЕ СМОГ оценить это предложение:** ${opts.uncheckedReason}. Задача заведена (гейт не обнуляет выдачу), но вторых глаз у неё не было — проверь сам.\n`
      : null,
    `## Зачем (Scout-Innovator ${opts.dateKey})`,
    clean(p.why),
    '',
    '## Файлы для изменения',
    files.map(f => `- \`${f}\``).join('\n'),
    '',
    '## Шаги реализации',
    p.implementation_steps.map((s, i) => `${i + 1}. ${clean(s)}`).join('\n'),
    '',
    '## Критерии приёмки',
    p.acceptance_criteria.map(c => `- [ ] ${clean(c)}`).join('\n'),
    '',
    '---',
    `*Scout-Innovator ${opts.dateKey} · Сложность: ${p.complexity} · Категория: ${p.category}${opts.uncheckedReason ? ' · БЕЗ РЕВЬЮ КРИТИКА' : ''}*`,
    '',
    '---',
    '',
    opts.autoRun
      ? `@claude ${task}`
      : `Предложение собрано из чужих лент, человек его ещё не читал — рука сама не начнёт. Запустить: поставить метку \`${HAND_LABEL}\`.\n\nЗадание руке: ${task}`,
  ].filter((x): x is string => x !== null).join('\n');

  return {
    title: clean(p.title),
    body,
    labels: [SCOUT_PROPOSAL_LABEL, p.category, ...(opts.autoRun ? [HAND_LABEL] : [])],
  };
}
