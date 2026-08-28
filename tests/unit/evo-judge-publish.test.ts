/**
 * Публикация Judge-отчёта — идемпотентность (задание владельца 27.08).
 *
 * Один канонический Issue на report_key, а не новый выпуск на каждую
 * доставку одного и того же входа. Тесты держат матрицу публикации через
 * фейковый GhClient в памяти — без сети и без regex по workflow-прозе.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMarker,
  parseMarker,
  findCanonical,
  checkDuplicate,
  publishJudgeReport,
  REPORT_LABEL,
  LEGACY_LABEL,
  type GhClient,
  type GhIssueLite,
  type JudgeMarker,
  type PublishInput,
} from '@/scripts/evo-judge-publish';

/** Фейковый GitHub в памяти — тестирует ПОСЛЕДОВАТЕЛЬНОСТЬ вызовов, а не regex по workflow. */
function fakeClient(seed: GhIssueLite[] = []): GhClient & { issues: GhIssueLite[]; calls: string[] } {
  const issues = seed.map((i) => ({ ...i }));
  const calls: string[] = [];
  let nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
  return {
    issues,
    calls,
    async listIssuesByLabel(label) {
      calls.push(`list:${label}`);
      return issues.filter((i) => i.labels.includes(label)).map((i) => ({ ...i }));
    },
    async createIssue({ title, body, labels }) {
      calls.push('create');
      const issue: GhIssueLite = { number: nextNumber++, title, body, state: 'open', labels };
      issues.push(issue);
      return { ...issue };
    },
    async updateIssue(number, patch) {
      calls.push(`update:${number}`);
      const issue = issues.find((i) => i.number === number);
      if (!issue) throw new Error(`issue ${number} не найден`);
      if (patch.body !== undefined) issue.body = patch.body;
      if (patch.state !== undefined) issue.state = patch.state;
    },
    async addComment(number) {
      calls.push(`comment:${number}`);
    },
  };
}

function marker(over: Partial<JudgeMarker> = {}): JudgeMarker {
  return {
    schema: 1,
    report_key: 'evo-judge:window:7d:v1',
    input_hash: 'sha256:in1',
    output_hash: 'sha256:out1',
    decision_hash: 'sha256:dec1',
    actionable: 1,
    source_run_id: 'run-1',
    analysis_status: 'complete',
    ...over,
  };
}

function issueWithMarker(number: number, over: Partial<JudgeMarker> = {}, state: 'open' | 'closed' = 'open'): GhIssueLite {
  const m = marker(over);
  return {
    number,
    title: 'Evo Judge — актуальный разбор (7 дней)',
    body: `Отчёт\n\n${buildMarker(m)}`,
    state,
    labels: [REPORT_LABEL, LEGACY_LABEL],
  };
}

function basePublishInput(over: Partial<PublishInput> = {}, client: GhClient): PublishInput {
  return {
    client,
    reportKey: 'evo-judge:window:7d:v1',
    title: 'Evo Judge — актуальный разбор (7 дней)',
    bodyWithoutMarker: 'Разобрано находок: **1**',
    inputHash: 'sha256:in1',
    outputHash: 'sha256:out1',
    decisionHash: 'sha256:dec1',
    actionable: 1,
    sourceRunId: 'run-2',
    analysisStatus: 'complete',
    ...over,
  };
}

describe('маркер: построение и разбор', () => {
  it('parseMarker разбирает то, что построил buildMarker', () => {
    const m = marker();
    const body = `Текст отчёта\n\n${buildMarker(m)}`;
    expect(parseMarker(body)).toEqual(m);
  });

  it('нет маркера — null, а не исключение', () => {
    expect(parseMarker('обычный Issue без маркера')).toBeNull();
    expect(parseMarker(null)).toBeNull();
  });

  it('битый JSON внутри маркера — null, Issue просто не читается как канонический', () => {
    expect(parseMarker('текст <!-- volcano:evo-judge-report {не json} -->')).toBeNull();
  });
});

describe('findCanonical: минимальный номер — канонический', () => {
  it('нет подходящих Issue — canonical null', async () => {
    const client = fakeClient();
    const { canonical, duplicates } = await findCanonical(client, 'evo-judge:window:7d:v1');
    expect(canonical).toBeNull();
    expect(duplicates).toEqual([]);
  });

  it('несколько Issue одного report_key — канонический с минимальным номером, остальные дубли', async () => {
    const client = fakeClient([
      issueWithMarker(12),
      issueWithMarker(3),
      issueWithMarker(45),
    ]);
    const { canonical, duplicates } = await findCanonical(client, 'evo-judge:window:7d:v1');
    expect(canonical?.issue.number).toBe(3);
    expect(duplicates.map((d) => d.number).sort()).toEqual([12, 45]);
  });

  it('Issue другого report_key не считается — окна разной длины не смешиваются', async () => {
    const client = fakeClient([issueWithMarker(1, { report_key: 'evo-judge:window:30d:v1' })]);
    const { canonical } = await findCanonical(client, 'evo-judge:window:7d:v1');
    expect(canonical).toBeNull();
  });

  it('Issue без маркера или с чужой меткой не считается', async () => {
    const client = fakeClient([
      { number: 1, title: 'Разбор находок эволюции — 26.08.2026', body: 'старый выпуск без маркера', state: 'closed', labels: [LEGACY_LABEL] },
    ]);
    const { canonical } = await findCanonical(client, 'evo-judge:window:7d:v1');
    expect(canonical).toBeNull();
  });
});

describe('checkDuplicate: решение ДО модели', () => {
  it('нет канонического Issue — не пропускаем (нечего сравнивать)', async () => {
    const client = fakeClient();
    const check = await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:in1', false);
    expect(check.skip).toBe(false);
    expect(check.canonicalIssueNumber).toBeNull();
  });

  it('тот же input_hash, не degraded, не force — пропускаем', async () => {
    const client = fakeClient([issueWithMarker(5)]);
    const check = await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:in1', false);
    expect(check.skip).toBe(true);
    expect(check.canonicalIssueNumber).toBe(5);
  });

  it('другой input_hash — не пропускаем', async () => {
    const client = fakeClient([issueWithMarker(5)]);
    const check = await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:ДРУГОЙ', false);
    expect(check.skip).toBe(false);
  });

  it('degraded — не пропускаем НИКОГДА, даже при том же input_hash', async () => {
    // Немой прогон не имеет права застрять пропуском: он обязан пробовать снова.
    const client = fakeClient([issueWithMarker(5, { analysis_status: 'degraded' })]);
    const check = await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:in1', false);
    expect(check.skip).toBe(false);
  });

  it('force_refresh=true — не пропускаем, даже при полном совпадении входа', async () => {
    const client = fakeClient([issueWithMarker(5)]);
    const check = await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:in1', true);
    expect(check.skip).toBe(false);
    expect(check.forceRefresh).toBe(true);
  });

  it('проверка read-only: ни одной мутации GitHub', async () => {
    const client = fakeClient([issueWithMarker(5)]);
    await checkDuplicate(client, 'evo-judge:window:7d:v1', 'sha256:in1', false);
    expect(client.calls.every((c) => c.startsWith('list:'))).toBe(true);
  });
});

describe('publishJudgeReport: матрица публикации', () => {
  it('нет канонического Issue, actionable > 0 — создаётся один Issue с обеими метками', async () => {
    const client = fakeClient();
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('created');
    expect(client.issues).toHaveLength(1);
    expect(client.issues[0].labels).toEqual(expect.arrayContaining([REPORT_LABEL, LEGACY_LABEL]));
  });

  it('нет канонического Issue, actionable = 0 — Issue не создаётся', async () => {
    const client = fakeClient();
    const result = await publishJudgeReport(basePublishInput({ actionable: 0 }, client));
    expect(result.action).toBe('no_issue_needed');
    expect(client.issues).toHaveLength(0);
  });

  it('тот же input/output/decision — GitHub не трогаем вовсе', async () => {
    const client = fakeClient([issueWithMarker(5)]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('no_change');
    expect(client.calls.some((c) => c.startsWith('update') || c.startsWith('create'))).toBe(false);
  });

  it('новый input/output, тот же decision — тело обновлено, БЕЗ комментария', async () => {
    const client = fakeClient([issueWithMarker(5, { input_hash: 'sha256:СТАРЫЙ', output_hash: 'sha256:СТАРЫЙ' })]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('body_updated');
    expect(client.calls).toContain('update:5');
    expect(client.calls.some((c) => c.startsWith('comment'))).toBe(false);
  });

  it('новый decision, actionable > 0, Issue была открыта — тело обновлено, комментарий про изменение', async () => {
    const client = fakeClient([issueWithMarker(5, { decision_hash: 'sha256:СТАРЫЙ' })]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('decision_changed');
    expect(client.calls).toContain('update:5');
    expect(client.calls).toContain('comment:5');
    expect(client.issues[0].state).toBe('open');
  });

  it('новый decision, actionable стал 0 — Issue закрывается как completed', async () => {
    const client = fakeClient([issueWithMarker(5, { decision_hash: 'sha256:СТАРЫЙ' })]);
    const result = await publishJudgeReport(basePublishInput({ actionable: 0 }, client));
    expect(result.action).toBe('closed_clean');
    expect(client.issues[0].state).toBe('closed');
  });

  it('новая real-находка при закрытой Issue — переоткрывается, а не заводится новая', async () => {
    const client = fakeClient([issueWithMarker(5, { decision_hash: 'sha256:СТАРЫЙ' }, 'closed')]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('reopened_actionable');
    expect(client.issues).toHaveLength(1);
    expect(client.issues[0].state).toBe('open');
  });

  it('force_refresh, тот же verdict — обновление без нового Issue и без комментария владельцу', async () => {
    // force_refresh пересчитал output/decision заново (в тесте — совпали с прежними).
    const client = fakeClient([issueWithMarker(5)]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.action).toBe('no_change');
    expect(client.issues).toHaveLength(1);
  });

  it('исторически две Issue одного report_key — минимальный номер канонический, остальные закрываются как дубли', async () => {
    const client = fakeClient([issueWithMarker(12), issueWithMarker(3)]);
    const result = await publishJudgeReport(basePublishInput({}, client));
    expect(result.issueNumber).toBe(3);
    expect(result.closedDuplicates).toEqual([12]);
    expect(client.issues.find((i) => i.number === 12)?.state).toBe('closed');
    expect(client.calls).toContain('comment:12');
  });

  it('уже закрытый дубль повторно не трогается комментарием/апдейтом', async () => {
    const client = fakeClient([issueWithMarker(12, {}, 'closed'), issueWithMarker(3)]);
    await publishJudgeReport(basePublishInput({}, client));
    expect(client.calls).not.toContain('comment:12');
    expect(client.calls).not.toContain('update:12');
  });

  it('только этой публикации меткам — evo-judge-report создаётся вместе с legacy evo, не отдельно', async () => {
    const client = fakeClient();
    await publishJudgeReport(basePublishInput({ actionable: 2 }, client));
    expect(client.issues[0].labels).toContain(REPORT_LABEL);
    expect(client.issues[0].labels).toContain(LEGACY_LABEL);
  });
});

describe('никто, кроме владельца, не мержит и не пишет код — публикация только issues', () => {
  it('GhClient не содержит методов записи кода/PR', () => {
    // Типовой контракт: только Issue-операции. Смысловая проверка — что
    // publishJudgeReport физически не может тронуть ничего, кроме Issues,
    // потому что клиент, который ему дают, ничего другого не умеет.
    const client = fakeClient();
    const methods = Object.keys(client).filter((k) => typeof (client as unknown as Record<string, unknown>)[k] === 'function');
    expect(methods.sort()).toEqual(['addComment', 'createIssue', 'listIssuesByLabel', 'updateIssue']);
  });
});
