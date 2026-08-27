/**
 * Volcano OS — policy decision point операционных действий.
 *
 * Модель автономии (решение владельца 27.08): операционное решение —
 * ТОЛЬКО allow или deny, автоматически. Незнакомая capability отклоняется
 * со следом, а не создаёт очередь ручного approval; расширение полномочий —
 * PR-изменением этого реестра, который мержит человек. ask из операционного
 * пути удалён; ApprovalRequired ядром больше не вызывается (остался
 * legacy-хранилищем старых одобрений).
 *
 * Policy проверяет не только строку capability (исправление 27.08):
 * - principal — из доверенного контекста (JWT/сессия/CRON_SECRET), тип
 *   principal сверяется с реестром;
 * - ownership ресурса — частью policy, а не случайным WHERE в handler'е:
 *   pre_commit ЧИТАЕТ текущее состояние ресурса из БД;
 * - фаза admission — быстрые статические проверки, фаза pre_commit — то же
 *   плюс доменные инварианты непосредственно перед эффектом.
 */

import { pool } from '@/lib/db-pool';
import type { PolicyContext, PolicyVerdict, TrustedPrincipal } from './types';

export interface CapabilityEntry {
  /** Кто вправе звать: типы principal из доверенного контекста. */
  principalTypes: ReadonlyArray<TrustedPrincipal['type']>;
  /** Почему разрешено — читает человек при ревью реестра (PR). */
  reason: string;
  /**
   * Доменная проверка pre_commit: читает ТЕКУЩЕЕ состояние ресурса.
   * null — разрешено; строка — причина отказа.
   */
  precommit?: (ctx: PolicyContext) => Promise<string | null>;
}

/** Оператор владеет туром — единственный источник правды operator_tours. */
async function operatorOwnsTour(ctx: PolicyContext): Promise<string | null> {
  if (!ctx.resource?.id) return 'ресурс tour не указан';
  const tourId = parseInt(ctx.resource.id, 10);
  if (Number.isNaN(tourId)) return `некорректный id тура: ${ctx.resource.id}`;
  const { rows } = await pool.query<{ operator_id: string }>(
    `SELECT operator_id::text FROM operator_tours WHERE id = $1 AND deleted_at IS NULL`,
    [tourId],
  );
  if (rows.length === 0) return `тур ${tourId} не найден или удалён`;
  // Обе стороны — строками: pg отдаёт int как number, principal.id — строка.
  if (String(rows[0].operator_id) !== String(ctx.principal.id)) {
    return `тур ${tourId} принадлежит другому оператору`;
  }
  return null;
}

/**
 * Реестр операционных capabilities — только то, что реально подключено.
 * Расширять вместе с настоящим вызывающим кодом, не «на будущее»
 * (урок ACTION_CATEGORIES до PR #1399). Каждая строка — полномочие,
 * которое человек выдал мержем PR с этой строкой.
 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityEntry>> = {
  'tour.set_published': {
    principalTypes: ['operator'],
    reason: 'оператор меняет публикацию СВОЕГО тура; ownership проверяет policy, действие обратимо',
    precommit: operatorOwnsTour,
  },
  'tour.update_price': {
    principalTypes: ['operator'],
    reason: 'оператор меняет цену СВОЕГО тура; ownership проверяет policy, действие обратимо',
    precommit: operatorOwnsTour,
  },
  'tour.create_draft': {
    principalTypes: ['operator'],
    reason: 'черновик тура (is_published=false) из чата оператора; наружу не виден, обратим',
  },
  'evo.run': {
    principalTypes: ['cron'],
    reason: 'оркестратор читает и предлагает; мутации кода идут через draft PR + merge человека',
  },
  'code.merge': {
    principalTypes: ['cron', 'system'],
    reason: 'координация merge-gate: задача отражает жизненный цикл agent-PR; сам merge делает ТОЛЬКО человек в GitHub — эффекта слияния у этой capability нет по построению',
  },

  // ── Инициативы: capability = initiative.<action_type>, поимённо ────────
  // Допущено только обратимое и информирующее. Опасные типы перечислены в
  // FORBIDDEN_CAPABILITIES с причинами — они не «неизвестные», они
  // ЗАПРЕЩЕНЫ до отдельного policy-PR.
  'initiative.send_notification': {
    principalTypes: ['admin', 'cron'],
    reason: 'Telegram-уведомление владельцу: информирует, ничего не меняет',
  },
  'initiative.bulk_notify': {
    principalTypes: ['admin', 'cron'],
    reason: 'дайджест владельцу по лидам/турам: читает и информирует',
  },
  'initiative.schedule_suggest': {
    principalTypes: ['admin', 'cron'],
    reason: 'legacy-алерт о расписании туров: читает и информирует (строки до переименования 27.08)',
  },
  'initiative.operator_warning': {
    principalTypes: ['admin', 'cron'],
    reason: 'предупреждение оператору: запись в лог + Telegram владельцу, мутаций нет',
  },
  'initiative.ui_copy_change': {
    principalTypes: ['admin', 'cron'],
    reason: 'AI-переписывание описаний туров: обратимо, тот же класс действий давно делает Editor по крону',
  },
  'initiative.price_change': {
    principalTypes: ['admin', 'cron'],
    reason: 'создаёт ЗАПИСЬ A/B-эксперимента, цены не меняет',
  },
  'initiative.zone_capacity': {
    principalTypes: ['admin', 'cron'],
    reason: 'лимит посещений зоны: обратимая запись с валидацией диапазона',
  },
  'initiative.prompt_optimize': {
    principalTypes: ['admin', 'cron'],
    reason: 'пишет инсайты в agent_memory: не исполняет, только предлагает',
  },
  'initiative.tour_suspend': {
    principalTypes: ['admin', 'cron'],
    reason: 'приостановка тура с плохими отзывами: is_active=false, обратимо, защищает туристов',
  },
  'initiative.code_change': {
    principalTypes: ['admin', 'cron'],
    reason: 'готовит draft PR: решение принимает человек мержем — это и есть единственный human gate',
  },
  'initiative.new_page_create': {
    principalTypes: ['admin', 'cron'],
    reason: 'готовит draft PR новой страницы: решение принимает человек мержем',
  },
};

/**
 * Явно запрещённое — С ПРИЧИНАМИ. Отличие от неизвестного намеренное:
 * незнакомое отклоняется как незнакомое, запрещённое — как запрещённое,
 * и снять запрет можно только policy-PR, который мержит человек.
 */
export const FORBIDDEN_CAPABILITIES: Readonly<Record<string, string>> = {
  'data.delete': 'удаление данных агентом запрещено системой',
  'auth.bypass': 'обход аутентификации запрещён системой',
  'schema.change': 'изменение схемы БД — только миграцией через PR',
  'payment.execute': 'исполнение платежей агентом запрещено системой',
  'safeguard.modify': 'изменение предохранителей агентом запрещено системой',
  'initiative.archive_sos': 'SOS-эффекты исключены из автономии (решение владельца 27.08)',
  'initiative.security_block': 'блокировка пользователей/IP — auth-эффект, вне автономии до отдельного policy-PR',
  'initiative.flag_payment': 'платёжные записи — вне автономии до отдельного policy-PR',
  'initiative.commission_change': 'комиссии операторов — деньги, вне автономии до отдельного policy-PR',
  'initiative.sql_query_fix': 'правка кода на проде мимо PR запрещена: код меняется только draft PR + merge человека',
  'initiative.ab_scale_winner': 'применение победителя A/B меняет цены — вне автономии до отдельного policy-PR',
  'initiative.operator_outreach': 'исходящие сообщения третьим лицам необратимы — вне автономии до отдельного policy-PR',
};

/**
 * Решение policy по контексту. unknown → deny (fail-closed), forbidden →
 * deny с причиной запрета; pre_commit дополнительно читает текущее
 * состояние ресурса. Решение вычисляется заново на каждой фазе — между
 * admission и pre_commit состояние могло устареть.
 */
export async function decidePolicy(ctx: PolicyContext): Promise<PolicyVerdict> {
  const forbidden = FORBIDDEN_CAPABILITIES[ctx.capability];
  if (forbidden) return { decision: 'deny', reason: forbidden };

  const entry = CAPABILITY_REGISTRY[ctx.capability];
  if (!entry) {
    return {
      decision: 'deny',
      reason: `capability '${ctx.capability}' не в реестре policy — расширение полномочий только PR-изменением реестра`,
    };
  }
  if (!entry.principalTypes.includes(ctx.principal.type)) {
    return {
      decision: 'deny',
      reason: `principal типа '${ctx.principal.type}' не вправе звать '${ctx.capability}'`,
    };
  }
  if (ctx.phase === 'pre_commit' && entry.precommit) {
    try {
      const denied = await entry.precommit(ctx);
      if (denied) return { decision: 'deny', reason: denied };
    } catch (err) {
      // Не смогли проверить ≠ разрешено (§4.0): отказ с причиной.
      return {
        decision: 'deny',
        reason: `pre_commit проверка не выполнена: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { decision: 'allow', reason: entry.reason };
}
