import { pool } from '@/lib/db-pool';
import type { JWTPayload } from '@/lib/auth/jwt';
import { operatorAccess } from '@/lib/operators/team-access';

/**
 * Скоуп владения лидом — единая формула для всех эндпоинтов /api/leads/*:
 * админ видит всё; оператор — свои лиды, а ничейные (operator_id IS NULL) —
 * только если его карточку допустил на витрину администратор (`is_public`).
 * Вошедший с ролью оператора без карточки партнёра не видит ничего.
 *
 * 14.11: до этого дня ничейные заявки с именем, телефоном и почтой видел
 * ЛЮБОЙ вошедший с ролью оператора. Роль выдаётся обычной регистрацией
 * (app/api/auth/register), карточка партнёра создаётся там же, — то есть
 * контакты туристов, оставивших заявку без адресата (планер, главная,
 * /request, /contact, сохранённая поездка), читал любой, кто зарегистрировался
 * оператором. Тот же дефект, что закрыт 26.09 у агентов: проверка роли без
 * проверки допуска — не защита. Допуск — тот же признак, по которому добивка
 * отдаёт заявку без адресата оператору (app/api/cron/leads-followup):
 * `partners.is_public`, его ставит только администратор.
 *
 * Раньше жила только внутри app/api/leads/[id]/route.ts (GET/PATCH). Четыре
 * соседних эндпоинта того же ресурса (proposal, proposal/send, proposal/pdf,
 * process) проверяли только РОЛЬ через requireOperator, не владение —
 * оператор А мог по чужому UUID читать/скачивать PD туриста (имя, телефон,
 * email), перезапускать AI-обработку и слать предложение от имени
 * платформы (аудит кабинета оператора).
 *
 * С 29.10 у формулы два входа: кабинет оператора (`operatorLeadScope`) и
 * раздел «Свои туры» гида — скоуп `{ kind: 'owner', claimUnowned: false }`:
 * гид отвечает только на заявки, адресованные ему, ничейные не видит и не
 * занимает (lib/leads/owner-lead-status).
 */
export type LeadScope =
  /** Администратор: любой лид. */
  | { kind: 'admin' }
  /**
   * Продавец: лиды его карточки. `claimUnowned` — видит и ничейные, и первое
   * действие над ничейным делает его своим (кабинет оператора, 25.09).
   */
  | { kind: 'owner'; partnerId: string; claimUnowned: boolean }
  /**
   * Вошедший с ролью оператора без карточки партнёра: своих лидов у него нет,
   * а ничейные ему закрыты (14.11) — до этого дня он видел их все.
   */
  | { kind: 'none' };

/**
 * Скоуп кабинета оператора. Кабинет — свой или команды (CRM 2г, миграция
 * 1223): менеджер видит лиды своего оператора. operatorAccess ищет партнёра
 * только category='operator' — у user_id бывает и гид-профиль, LIMIT 1 без
 * фильтра брал произвольный.
 */
export async function operatorLeadScope(user: JWTPayload): Promise<LeadScope> {
  if (user.role === 'admin') return { kind: 'admin' };
  const access = await operatorAccess(user.userId);
  // «Не смогли проверить» — не «партнёра нет»: иначе оператор молча увидел бы
  // только ничейные лиды. Бросаем — роут отвечает ошибкой, как при сбое базы.
  if (access.kind === 'unavailable') throw new Error(`доступ к кабинету не проверен: ${access.reason}`);
  if (access.kind === 'none') return { kind: 'none' };
  return { kind: 'owner', partnerId: access.partnerId, claimUnowned: await partnerAdmitted(access.partnerId) };
}

/**
 * Допущена ли карточка оператора к заявкам без адресата. Признак —
 * `partners.is_public`: его ставит только администратор
 * (app/api/admin/content/partners/[id]), регистрация пишет FALSE. Карточки нет
 * или признак не TRUE — не допущена.
 *
 * «Не смогли прочитать» — не «допущена» и не «не допущена»: бросаем, роут
 * отвечает ошибкой, как при непроверенном доступе к кабинету (§4.0).
 */
export async function partnerAdmitted(partnerId: string, db: Pick<typeof pool, 'query'> = pool): Promise<boolean> {
  try {
    const { rows } = await db.query<{ is_public: boolean | null }>(
      `SELECT is_public FROM partners WHERE id = $1::uuid`,
      [partnerId],
    );
    return rows[0]?.is_public === true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error('[leads/ownership] допуск к заявкам без адресата не проверен, SQLSTATE', code);
    throw new Error(`допуск к заявкам без адресата не проверен: sqlstate ${code}`);
  }
}

/**
 * Открыт ли вошедшему общий список заявок без адресата — для строки на
 * экране: кабинет, которому он закрыт, говорит об этом словами, а не
 * показывает пустую доску.
 */
export function unownedPoolOpen(scope: LeadScope): boolean {
  return scope.kind === 'admin' || (scope.kind === 'owner' && scope.claimUnowned);
}

/**
 * SQL-хвост условия по скоупу (нумерация параметров продолжается с nextIdx).
 * Колонка — `operator_id` таблицы leads без псевдонима.
 */
export function leadScopeCond(scope: LeadScope, nextIdx: number): { cond: string; vals: unknown[] } {
  switch (scope.kind) {
    case 'admin':
      return { cond: '', vals: [] };
    case 'none':
      return { cond: ' AND FALSE', vals: [] };
    case 'owner':
      return scope.claimUnowned
        ? { cond: ` AND (operator_id = $${nextIdx} OR operator_id IS NULL)`, vals: [scope.partnerId] }
        : { cond: ` AND operator_id = $${nextIdx}`, vals: [scope.partnerId] };
  }
}

/** Условие владения для кабинета оператора — `leadScopeCond(operatorLeadScope(user))`. */
export async function leadOwnershipCond(
  user: JWTPayload,
  nextIdx: number
): Promise<{ cond: string; vals: unknown[] }> {
  return leadScopeCond(await operatorLeadScope(user), nextIdx);
}

/**
 * Проверка владения одним лидом — true, если лид доступен этому пользователю
 * (свой; ничейный — допущенному кабинету; админ — любой). Для эндпоинтов, которым не нужен сам SELECT лида,
 * только факт доступа (proposal/send, process).
 */
export async function canAccessLead(user: JWTPayload, leadId: string): Promise<boolean> {
  const scope = await leadOwnershipCond(user, 2);
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM leads WHERE id = $1${scope.cond} LIMIT 1`,
    [leadId, ...scope.vals]
  );
  return res.rows.length > 0;
}
