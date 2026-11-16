/**
 * Политика о сроках хранения говорит то, что делает уборка (#3388, п. 2).
 *
 * Что держится:
 *  - у каждого срока названа точка отсчёта: заявка — последнее изменение,
 *    бронь — дата тура, профиль — вход или регистрация, журнал — запись;
 *  - обещание «записи учёта остаются без …» покрывает каждое поле, которое
 *    уборка стирает (`PURGE_STEPS`): поле, стёртое молча, или слово
 *    политики, за которым нет шага, — красное;
 *  - суточный прогон зовёт уборку с `apply=1` и краснеет, когда она не
 *    ответила, не убрала таблицу или ответила сухим прогоном (шаг
 *    исполняется настоящим bash с подложенным curl).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import PrivacyPage from '@/app/legal/privacy/page';
import { PURGE_STEPS } from '@/lib/legal/retention-purge';

const policyText = (): string => {
  const { container } = render(<PrivacyPage />);
  return (container.textContent ?? '').replace(/\s+/g, ' ');
};

/**
 * Каким словом политики названо каждое поле, которое уборка стирает в
 * оставляемых записях. `null` — поле стирается сверх обещанного: политика о
 * нём не говорит, потому что в других оставляемых записях (выдача прав)
 * ссылка на учётную запись остаётся.
 */
const FIELD_WORDS: Record<string, string | null> = {
  'a2a_requests.context_key': 'вызывающей программы',
  'a2a_requests.caller_hash': 'вызывающей программы',
  'mcp_tool_calls.caller_hash': 'вызывающей программы',
  'mcp_tool_calls.arg_value': 'текста обращения к программному интерфейсу',
  'page_views.visitor_hash': 'идентификаторов посетителя',
  'page_views.session_id': 'идентификаторов посетителя',
  'page_views.ip_hash': 'IP-адреса',
  'page_views.referrer': 'адреса страницы, с которой пришёл посетитель',
  'audit_log.ip_address': 'IP-адреса',
  'audit_log.user_agent': 'данных браузера',
  'audit_log.data.email': 'адреса электронной почты',
  'audit_log.data.inn': 'ИНН',
  'audit_logs.ip_address': 'IP-адреса',
  'audit_logs.user_agent': 'данных браузера',
  'llm_usage_log.user_id': null,
  'tour_selection_events.visitor_ip': 'IP-адреса',
  'tour_selection_events.user_agent': 'данных браузера',
};

function erasedFields(): string[] {
  const out: string[] = [];
  for (const s of PURGE_STEPS) {
    if (s.action.kind !== 'anonymize') continue;
    for (const c of [...s.action.nullable, ...(s.action.notNull ?? [])]) out.push(`${s.table}.${c}`);
    const j = s.action.jsonDrop;
    if (j) for (const k of j.keys) out.push(`${s.table}.${j.column}.${k}`);
  }
  return out;
}

describe('политика: сроки хранения', () => {
  it('у каждого срока названа точка отсчёта', () => {
    const text = policyText();
    expect(text).toContain('3 лет с момента последней активности (последнего входа на Платформу или регистрации)');
    expect(text).toContain('История бронирований — 5 лет с даты тура');
    expect(text).toContain('Данные лид-форм — 3 года с последнего изменения заявки');
    expect(text).toContain('Технические логи — 90 дней с момента записи');
    expect(text).toContain('Записи старше 90 дней удаляются');
  });

  it('«остаются, но без …» покрывает каждое поле, которое стирает уборка, и не обещает лишнего', () => {
    const text = policyText();
    const fields = erasedFields();
    expect(fields.filter((f) => !(f in FIELD_WORDS)), 'поле стирается, а политика о нём не знает — внести в FIELD_WORDS').toEqual([]);
    expect(Object.keys(FIELD_WORDS).filter((f) => !fields.includes(f)), 'слово политики без шага уборки').toEqual([]);
    const promise = text.slice(text.indexOf('остаются, но без'), text.indexOf('Журналы работы самой Платформы'));
    expect(promise.length).toBeGreaterThan(20);
    for (const [f, word] of Object.entries(FIELD_WORDS)) {
      if (word) expect(promise, f).toContain(word);
    }
  });
});

describe('суточный прогон включает уборку', () => {
  type Step = { name?: string; run?: string };
  const wf = load(readFileSync('.github/workflows/cron-client-errors.yml', 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  const step = Object.values(wf.jobs).flatMap((j) => j.steps).find((s) => String(s.run ?? '').includes('/api/cron/retention-purge'));

  function runStep(body: Record<string, unknown>, code = '200') {
    const dir = mkdtempSync(join(tmpdir(), 'retention-purge-step-'));
    try {
      const out = join(dir, 'purge.json');
      const args = join(dir, 'curl-args');
      // Подложенный curl: пишет ответ в файл из -o, печатает код, запоминает адрес.
      writeFileSync(join(dir, 'curl'), `#!/bin/sh
echo "$@" > "${args}"
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf '%s' "$FAKE_BODY" > "$1"; fi; shift; done
printf '%s' "$FAKE_CODE"
`);
      chmodSync(join(dir, 'curl'), 0o755);
      const script = String(step?.run ?? 'exit 99').split('/tmp/purge.json').join(out);
      const r = spawnSync('bash', ['-c', script], {
        env: {
          PATH: `${dir}:${process.env.PATH ?? ''}`, CRON_SECRET: 'test',
          GITHUB_STEP_SUMMARY: join(dir, 'summary'), FAKE_BODY: JSON.stringify(body), FAKE_CODE: code,
        },
        encoding: 'utf8',
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, url: readFileSync(args, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const row = (table: string, extra: Record<string, unknown> = {}) => ({ table, action: 'delete', state: 'ok', rows: 1, more: false, ...extra });

  it('зовёт уборку с apply=1; убрано — зелёный', () => {
    const r = runStep({ ok: true, apply: true, total: 2, failed: 0, rows: [row('a'), row('b')] });
    expect(r.url).toContain('retention-purge?apply=1');
    expect(r.status).toBe(0);
  });

  it('сухой прогон вместо уборки — красный', () => {
    const r = runStep({ ok: true, apply: false, total: 2, failed: 0, rows: [row('a')] });
    expect(r.status).toBe(1);
    expect(r.out).toContain('сухим прогоном');
  });

  it('таблица не убралась — красный; уборка не ответила — красный', () => {
    expect(runStep({ ok: true, apply: true, total: 0, failed: 1, rows: [{ table: 'a', state: 'failed', reason: 'SQLSTATE 57014' }] }).status).toBe(1);
    expect(runStep({ error: 'Unauthorized' }, '401').status).toBe(1);
  });

  it('остаток сверх потолка пачек — предупреждение, а не красный', () => {
    const r = runStep({ ok: true, apply: true, total: 100000, failed: 0, rows: [row('page_views', { more: true })] });
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning::');
    expect(r.out).toContain('page_views');
  });
});
