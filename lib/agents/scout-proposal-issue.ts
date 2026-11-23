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
 * заводится и ждёт человека: поставил метку `agent-proposal` или написал
 * руке в комментарии — рука пошла. Двери закрыты в двух местах:
 *   - здесь: метки руки на задаче нет — «категория» модели берётся только
 *     из закрытого списка, иначе модель назвала бы категорией саму метку
 *     руки; упоминание руки снимается со всего, что пришло от модели, одним
 *     проходом по собранному тексту, а не по полям (ревью 23.11: поля
 *     «сложность» и «категория» остались непрочищенными);
 *   - на воротах: по пометке в теле `claude.yml` не берёт задачу ни за то,
 *     что её завёл токен владельца, ни за упоминание руки в теле.
 * Пометка ставится только задаче, которая ждёт человека: при
 * `SCOUT_AUTOPR=1` задача заводится как раньше.
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
 * Пометка в теле задачи, которая ждёт человека. `claude.yml` по ней не
 * запускает руку ни на «задачу открыл владелец» (открыл не человек, а его
 * токен), ни на упоминание руки в теле.
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

/** Категории и сложности, которые модель вправе назвать. */
const CATEGORIES: readonly string[] = ['feature', 'fix', 'performance', 'content', 'ux'];
const COMPLEXITIES: readonly string[] = ['small', 'medium', 'large'];

/**
 * Ответ модели приходит через `JSON.parse` и типом не проверен: поле может
 * оказаться чем угодно. Строка — только строка, список — только строки.
 */
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Значение из закрытого списка либо null: свободный текст в метку и подпись не идёт. */
const fromList = (list: readonly string[], v: unknown): string | null => (typeof v === 'string' && list.includes(v) ? v : null);

/**
 * Задача по предложению. `autoRun` — рука стартует сама: метка руки и
 * упоминание в теле. Без него задача ждёт человека, и это сказано в теле.
 */
export function buildProposalIssue(
  p: ProposalForIssue,
  opts: { dateKey: string; uncheckedReason: string | null; autoRun: boolean },
): ProposalIssue {
  const category = fromList(CATEGORIES, p.category);
  const complexity = fromList(COMPLEXITIES, p.complexity);
  const files = strings(p.files_to_change);

  // Всё, что пришло от модели, собирается отдельно и чистится ОДНИМ проходом:
  // новое поле не окажется вне очистки, как оказались «сложность» и «категория».
  const fromModel = withoutHandMention([
    // Непроверенное предложение обязано выглядеть иначе, чем прошедшее ревью:
    // человек в очереди читает первым делом верх тела.
    opts.uncheckedReason
      ? `> **Критик НЕ СМОГ оценить это предложение:** ${opts.uncheckedReason}. Задача заведена (гейт не обнуляет выдачу), но вторых глаз у неё не было — проверь сам.\n`
      : null,
    `## Зачем (Scout-Innovator ${opts.dateKey})`,
    text(p.why),
    '',
    '## Файлы для изменения',
    files.map(f => `- \`${f}\``).join('\n'),
    '',
    '## Шаги реализации',
    strings(p.implementation_steps).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '## Критерии приёмки',
    strings(p.acceptance_criteria).map(c => `- [ ] ${c}`).join('\n'),
    '',
    '---',
    `*Scout-Innovator ${opts.dateKey} · Сложность: ${complexity ?? 'не указана'} · Категория: ${category ?? 'не указана'}${opts.uncheckedReason ? ' · БЕЗ РЕВЬЮ КРИТИКА' : ''}*`,
  ].filter((x): x is string => x !== null).join('\n'));

  const task = withoutHandMention([
    `Реализуй это предложение. Ограничься файлами: ${files.join(', ')} (если нужен ещё файл — обоснуй в PR, не трогай защищённые: middleware.ts, lib/auth.ts, app/api/payments/, app/api/safety/sos).`,
    'Definition of done — все критерии приёмки из этой задачи выполнены и проверяемы.',
    "Обязательно по CLAUDE.md: TypeScript strict (unknown + type guards, без any), все цвета — CSS vars, SQL только параметризованный ($1,$2) и import { pool } from '@/lib/db-pool', таблицы operator_bookings (booking_status) / operator_tours / v_kamchatka_routes_api (не устаревшие bookings и tours, не прямой выбор из kamchatka_routes), Zod-валидация входных данных API и JWT на защищённых роутах, AI только через callAIWaterfall/callAIFast, без отладочного console-вывода в продакшн-коде, без эмодзи в коде/UI/логах, новая миграция — следующий свободный номер, идемпотентная.",
    // Полный набор руке запрещён её же инструкцией (claude.yml): шесть минут и
    // весь вывод в контексте, а CI прогонит то же на PR. До 23.11 задача
    // требовала полный прогон — два задания противоречили друг другу.
    'Перед завершением: npx tsc --noEmit (0 ошибок) и целевые тесты — npx vitest run по затронутым файлам; полный набор прогонит CI. Оформи изменения как PR, не пушь напрямую в main.',
  ].join('\n'));

  const body = [
    // Пометка — только задаче, которая ждёт человека.
    opts.autoRun ? null : SCOUT_PROPOSAL_MARKER,
    fromModel,
    '',
    '---',
    '',
    opts.autoRun
      ? `@claude ${task}`
      : `Предложение собрано из чужих лент, человек его ещё не читал — рука сама не начнёт. Запустить: поставить метку \`${HAND_LABEL}\`.\n\nЗадание руке: ${task}`,
  ].filter((x): x is string => x !== null).join('\n');

  return {
    title: withoutHandMention(text(p.title)),
    body,
    // Метка категории — только из закрытого списка: иначе модель назвала бы
    // категорией метку руки, и задача стартовала бы без человека.
    labels: [SCOUT_PROPOSAL_LABEL, ...(category ? [category] : []), ...(opts.autoRun ? [HAND_LABEL] : [])],
  };
}
