/**
 * Команда оператора — сторона гида: прочитать, ответить на приглашение,
 * выйти. Одни функции для кабинета на сайте (`/api/guide/team`) и чата
 * кабинета (lib/guides/chat-role, слово владельца 30.10 «гид должен полностью
 * управлять своей ролью из MAX»).
 *
 * SQL — `TEAM_SQL` (lib/guides/team-queries), его исполняет pg-тест. Здесь —
 * порядок шагов в транзакции: сначала гид, потом приглашение (один порядок
 * блокировок на все пути), принятие — единственный писатель членства.
 * Гид ведёт одного оператора за раз: принять второе приглашение, не выйдя из
 * первой команды, нельзя — `other_team`, и это говорится словами.
 *
 * Отказ базы — исключение: вызывающий отвечает «не удалось» и пишет в лог.
 */

import { query, transaction } from '@/lib/database';
import { TEAM_SQL } from '@/lib/guides/team-queries';

export interface GuideTeam {
  operator: { id: string; name: string | null; phone: string | null } | null;
  invites: Array<{ id: string; operatorId: string; operatorName: string | null; createdAt: string }>;
}

/** Оператор команды и ждущие ответа приглашения гида. */
export async function readGuideTeam(guideId: string): Promise<GuideTeam> {
  const [membership, invites] = await Promise.all([
    query<{ operator_id: string | null; operator_name: string | null; operator_phone: string | null }>(
      TEAM_SQL.membership, [guideId],
    ),
    query<{ id: string; operator_id: string; operator_name: string | null; created_at: string }>(
      TEAM_SQL.pendingInvitesForGuide, [guideId],
    ),
  ]);
  const m = membership.rows[0];
  return {
    operator: m?.operator_id ? { id: m.operator_id, name: m.operator_name, phone: m.operator_phone } : null,
    invites: invites.rows.map((r) => ({
      id: r.id,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      createdAt: r.created_at,
    })),
  };
}

export type InviteAnswer = 'accept' | 'decline';
export type RespondOutcome =
  | { kind: 'ok'; operatorId: string }
  | { kind: 'not_found' }
  | { kind: 'other_team' };

/** Ответ на приглашение: только своё ждущее; принять — только не будучи в чужой команде. */
export async function respondGuideInvite(guideId: string, inviteId: string, action: InviteAnswer): Promise<RespondOutcome> {
  return transaction<RespondOutcome>(async (client) => {
    // Порядок блокировок один на все пути: сначала гид, потом приглашение.
    const guide = await client.query<{ guide_operator_id: string | null }>(TEAM_SQL.lockGuide, [guideId]);
    const invite = await client.query<{ id: string; operator_id: string }>(
      TEAM_SQL.lockPendingInviteForGuide, [inviteId, guideId],
    );
    if (invite.rows.length === 0 || guide.rows.length === 0) return { kind: 'not_found' };
    const target = invite.rows[0].operator_id;

    if (action === 'decline') {
      await client.query(TEAM_SQL.respondInvite, [inviteId, 'declined']);
      return { kind: 'ok', operatorId: target };
    }

    const current = guide.rows[0].guide_operator_id;
    if (current && current !== target) return { kind: 'other_team' };
    if (!current) await client.query(TEAM_SQL.setMembership, [guideId, target]);
    await client.query(TEAM_SQL.respondInvite, [inviteId, 'accepted']);
    return { kind: 'ok', operatorId: target };
  });
}

/**
 * Выйти из команды: членство снимается, принятое приглашение закрывается как
 * `left`, будущие назначения этого оператора снимаются. false — гид ни в
 * какой команде не состоит.
 */
export async function leaveGuideTeam(guideId: string): Promise<boolean> {
  return transaction<boolean>(async (client) => {
    const guide = await client.query<{ guide_operator_id: string | null }>(TEAM_SQL.lockGuide, [guideId]);
    const operatorId = guide.rows[0]?.guide_operator_id;
    if (!operatorId) return false;
    await client.query(TEAM_SQL.clearMembership, [guideId, operatorId]);
    await client.query(TEAM_SQL.closeAcceptedInvites, [guideId, operatorId, 'left']);
    await client.query(TEAM_SQL.unassignFutureBookings, [guideId, operatorId]);
    return true;
  });
}
