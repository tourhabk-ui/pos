/**
 * IDOR на роутах лида (разведка кабинета оператора, Рост-5 + аудит кабинета
 * оператора 24.08): «Проверки владения лидом нет — любой оператор может
 * открыть/изменить чужой лид по id». Список /api/leads скоупил лиды всегда
 * (свои + ничейные), а /api/leads/[id] — нет: requireOperator пускал ЛЮБОГО
 * оператора к ЛЮБОМУ лиду с телефоном и почтой туриста. Дыра закрыта единой
 * функцией lib/leads/ownership.ts — сторож держит её подключённой везде, где
 * читается/меняется чужой лид.
 *
 * 24.08: та же формула была пропущена в ЧЕТЫРЁХ соседних роутах того же
 * ресурса (proposal, proposal/send, proposal/pdf, оба process) — оператор
 * мог по чужому UUID скачать PDF с именем/телефоном туриста, перезапустить
 * AI-обработку и отправить предложение от имени платформы. Функция
 * вынесена в общий модуль ИМЕННО чтобы такой дрейф не повторялся: один
 * источник формулы, а не шесть копий, которые расходятся по одной.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OWNERSHIP = readFileSync(join(ROOT, 'lib/leads/ownership.ts'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'app/api/leads/[id]/route.ts'), 'utf-8');
const LIST = readFileSync(join(ROOT, 'app/api/leads/route.ts'), 'utf-8');
const PROPOSAL = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/route.ts'), 'utf-8');
const PROPOSAL_SEND = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/send/route.ts'), 'utf-8');
const PROPOSAL_PDF = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/pdf/route.ts'), 'utf-8');
const PROCESS_BY_ID = readFileSync(join(ROOT, 'app/api/leads/[id]/process/route.ts'), 'utf-8');
const PROCESS_BODY = readFileSync(join(ROOT, 'app/api/leads/process/route.ts'), 'utf-8');

describe('lib/leads/ownership.ts — единственный источник формулы', () => {
  it('формула: свои ИЛИ ничейные, админ без скоупа', () => {
    expect(OWNERSHIP).toMatch(/operator_id = \$\$\{nextIdx\} OR operator_id IS NULL/);
    expect(OWNERSHIP).toMatch(/user\.role === 'admin'.*\{ cond: '', vals: \[\] \}/);
    expect(OWNERSHIP).toMatch(/AND operator_id IS NULL/);
    expect(OWNERSHIP).toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
  });

  it('canAccessLead применяет ту же формулу через leadOwnershipCond', () => {
    expect(OWNERSHIP).toMatch(/canAccessLead[\s\S]*leadOwnershipCond/);
  });
});

describe('владение лидом: /api/leads/[id]', () => {
  it('GET и PATCH оба применяют скоуп владения к SQL', () => {
    const scoped = DETAIL.match(/\$\{scope\.cond\}/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    expect(DETAIL).toMatch(/UPDATE leads SET \$\{sets\.join\(', '\)\} WHERE id = \$\$\{idx\}\$\{scope\.cond\}/);
    expect(DETAIL).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('импортирует общую формулу, а не держит свою копию', () => {
    expect(DETAIL).toMatch(/import \{ leadOwnershipCond \} from '@\/lib\/leads\/ownership'/);
  });

  it('формула резолва партнёра совпадает со списком', () => {
    expect(LIST).toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
  });

  it('чужой лид неотличим от несуществующего: 404, не 403', () => {
    // 403 на чужом id раскрыл бы существование лида; в роуте 403 быть не должно
    // (право роли проверяет middleware, роут отвечает только 404).
    expect(DETAIL).not.toMatch(/status: 403/);
    expect(DETAIL).toMatch(/'Лид не найден' \}, \{ status: 404/);
  });

  it('DELETE остаётся только админским', () => {
    const deleteFn = DETAIL.slice(DETAIL.indexOf('export async function DELETE'));
    expect(deleteFn).toMatch(/requireAdmin\(request\)/);
  });
});

describe('владение лидом: четыре роута, где проверка была пропущена (аудит 24.08)', () => {
  it('GET /api/leads/[id]/proposal — скоуп применён к SELECT', () => {
    expect(PROPOSAL).toMatch(/import \{ leadOwnershipCond \} from '@\/lib\/leads\/ownership'/);
    expect(PROPOSAL).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('POST /api/leads/[id]/proposal/send — проверка ДО вызова sendProposalToClient', () => {
    expect(PROPOSAL_SEND).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeSend = PROPOSAL_SEND.slice(0, PROPOSAL_SEND.indexOf('sendProposalToClient(id'));
    expect(beforeSend).toMatch(/canAccessLead\(user, id\)/);
  });

  it('GET /api/leads/[id]/proposal/pdf — скоуп применён к SELECT', () => {
    expect(PROPOSAL_PDF).toMatch(/import \{ leadOwnershipCond \} from '@\/lib\/leads\/ownership'/);
    expect(PROPOSAL_PDF).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('POST /api/leads/[id]/process — проверка ДО leadProcessor.process', () => {
    expect(PROCESS_BY_ID).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeProcess = PROCESS_BY_ID.slice(0, PROCESS_BY_ID.indexOf('leadProcessor.process(id)'));
    expect(beforeProcess).toMatch(/canAccessLead\(user, id\)/);
  });

  it('POST /api/leads/process (lead_id из body) — проверка ДО leadProcessor.process', () => {
    expect(PROCESS_BODY).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeProcess = PROCESS_BODY.slice(0, PROCESS_BODY.indexOf('leadProcessor.process(lead_id)'));
    expect(beforeProcess).toMatch(/canAccessLead\(user, lead_id\)/);
  });
});
