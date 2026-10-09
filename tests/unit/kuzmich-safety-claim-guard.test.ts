/**
 * Сторож #2300 (решение владельца 09.10): утверждения Кузьмича о безопасности
 * сверяются с данными инструментов того же хода, человек разбирает после.
 *
 * - «безопасно» без данных, без проверки или вопреки им — поправка в том же
 *   ответе; предупреждение без опоры НЕ вырезается, а помечается;
 * - сверка стоит на всех поверхностях с инструментами ДО отправки (в
 *   мессенджерах — до SOS-блока, в веб-стриме — до отдачи по словам);
 * - в журнал разбора уходит отрывок ответа после redactPII, вопрос туриста —
 *   нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import {
  findSafetyClaims, guardSafetyClaims, UNCHECKED_ALL_CLEAR_NOTE, CONTRADICTED_ALL_CLEAR_NOTE,
} from '@/lib/kuzmich/safety-claim-guard';
import { recordSafetyReview } from '@/lib/kuzmich/safety-review-log';
import type { ToolRun } from '@/lib/agents/eval/grounding';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const run = (name: string, output: string): ToolRun => ({ name, producedData: true, output });
const GUARDIAN_ALERTS = run('get_guardian_context', 'Авачинский вулкан [ЖЁЛТЫЙ]\nАктивные алерты: Экстренное предупреждение на 9 октября (сильный ветер).');
const GUARDIAN_CALM = run('get_guardian_context', 'Авачинский вулкан [ЗЕЛЁНЫЙ]\nОпасности: камнепад на верхнем участке.');

describe('что считается утверждением', () => {
  it('«безопасно», «можно идти», «угрозы нет» — обещание безопасности', () => {
    expect(findSafetyClaims('Сейчас там безопасно, можно идти.').map((c) => c.kind)).toEqual(['all_clear', 'all_clear']);
    expect(findSafetyClaims('Угрозы нет.')[0]?.kind).toBe('all_clear');
  });

  it('под отрицанием, с условием и «безопасность» как тема — не обещание', () => {
    expect(findSafetyClaims('Сейчас там не безопасно.')).toEqual([]);
    expect(findSafetyClaims('Небезопасно идти одному.')).toEqual([]);
    expect(findSafetyClaims('Подниматься безопасно только с гидом.')).toEqual([]);
    expect(findSafetyClaims('Безопасность прежде всего.')).toEqual([]);
  });

  it('предупреждение о явлении — утверждение об опасности с ключом', () => {
    expect(findSafetyClaims('Дорога на Мутновский перекрыта.')).toEqual([{ kind: 'hazard', phrase: expect.any(String), hazard: 'перекрытие' }]);
    expect(findSafetyClaims('На реках паводок.')[0]?.hazard).toBe('паводок');
  });
});

describe('сверка с данными хода', () => {
  it('«безопасно» вопреки действующим предупреждениям — поправка, вердикт contradicted', () => {
    const r = guardSafetyClaims('Сейчас на Авачинском безопасно.', [GUARDIAN_ALERTS]);
    expect(r.verdict).toBe('contradicted');
    expect(r.text).toContain(CONTRADICTED_ALL_CLEAR_NOTE);
    expect(r.text.startsWith('Сейчас на Авачинском безопасно.')).toBe(true);
  });

  it('«безопасно» без сводки обстановки в этом ходе — поправка «не проверял»', () => {
    const r = guardSafetyClaims('Там безопасно.', [run('get_tours', 'ID1: тур')]);
    expect(r.verdict).toBe('unbacked');
    expect(r.text).toContain(UNCHECKED_ALL_CLEAR_NOTE);
  });

  it('ответ без инструментов — «не смог проверить», и «безопасно» всё равно с поправкой', () => {
    const r = guardSafetyClaims('Там безопасно.', null);
    expect(r.verdict).toBe('unverifiable');
    expect(r.text).toContain(UNCHECKED_ALL_CLEAR_NOTE);
  });

  it('«безопасно» при спокойной сводке — без поправки', () => {
    const r = guardSafetyClaims('По сводке сейчас безопасно.', [GUARDIAN_CALM]);
    expect(r.verdict).toBe('backed');
    expect(r.text).toBe('По сводке сейчас безопасно.');
  });

  it('предупреждение без опоры НЕ вырезается, а помечается', () => {
    const r = guardSafetyClaims('Дорога на Мутновский перекрыта.', [GUARDIAN_CALM]);
    expect(r.verdict).toBe('unbacked');
    expect(r.text).toContain('Дорога на Мутновский перекрыта.');
    expect(r.text).toContain('про перекрытие в сводках');
    expect(r.text).toContain('Предупреждение оставляю');
  });

  it('предупреждение с опорой — без пометки; без инструментов — тоже без пометки', () => {
    const backed = guardSafetyClaims('Участок дороги перекрыт.', [run('safety_status', 'Закрыт участок автодороги Начикинский совхоз')]);
    expect(backed.verdict).toBe('backed');
    expect(backed.text).toBe('Участок дороги перекрыт.');
    const noRuns = guardSafetyClaims('Участок дороги перекрыт.', null);
    expect(noRuns.flagged).toEqual([]);
    expect(noRuns.text).toBe('Участок дороги перекрыт.');
  });

  it('нет утверждений — текст как был, вердикт none', () => {
    expect(guardSafetyClaims('Тур стоит 60 000 ₽.', [])).toMatchObject({ verdict: 'none', text: 'Тур стоит 60 000 ₽.' });
  });
});

describe('журнал разбора', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it('пишет отрывок ответа после redactPII, без вопроса туриста', async () => {
    const g = guardSafetyClaims('Там безопасно, звони +7 900 123-45-67.', null);
    await recordSafetyReview('telegram', g, null);
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO kuzmich_safety_reviews/.test(sql as string));
    expect(insert).toBeTruthy();
    const params = insert![1] as unknown[];
    expect(String(params[5])).not.toContain('123-45-67');
    expect(insert![0]).not.toMatch(/user|chat_id|question/i);
  });

  it('ответ без утверждений не пишется', async () => {
    await recordSafetyReview('web', guardSafetyClaims('Привет!', []), []);
    expect(query).not.toHaveBeenCalled();
  });

  it('отказ записи — в лог, ответ туристу не роняется', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async () => { throw Object.assign(new Error('отказ базы'), { code: '42P01' }); });
    let thrown: unknown = null;
    try { await recordSafetyReview('web', guardSafetyClaims('Там безопасно.', null), null); } catch (e) { thrown = e; }
    expect(thrown).toBeNull();
    expect(spy).toHaveBeenCalledWith('[kuzmich-safety-review] запись разбора не сделана', expect.objectContaining({ sqlstate: '42P01' }));
    spy.mockRestore();
  });
});

describe('сверка стоит на всех поверхностях до отправки', () => {
  it('мессенджеры: до SOS-блока, по журналу только ответа из цикла инструментов', () => {
    const src = read('lib/kuzmich/core.ts');
    expect(src).toMatch(/const claimRuns = usedAgentLoopAnswer \? toolRuns : null;/);
    expect(src.indexOf('guardSafetyClaims(answer, claimRuns)')).toBeLessThan(src.indexOf('withSosBlock(claimGuard.text, userContent)'));
  });

  it('веб-чат: до SOS-блока; веб-стрим: до отдачи по словам', () => {
    const chat = read('app/api/ai/chat/route.ts');
    expect(chat.indexOf('guardSafetyClaims(answer')).toBeLessThan(chat.indexOf('withSosBlock(answer, rawMessage)'));
    const stream = read('app/api/ai/chat-stream/route.ts');
    expect(stream.indexOf('guardSafetyClaims(fullAnswer, streamToolRuns)')).toBeLessThan(stream.indexOf('flushWords(fullAnswer);\n          } else {'));
  });
});
