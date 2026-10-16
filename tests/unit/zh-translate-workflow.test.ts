// @vitest-environment node
/**
 * Цикл партий workflow zh-translate.yml — исполнением шага с подставным curl
 * (аудит 15.10, ZH-NUMERALS; CLAUDE.md §4 «сторож судит поведение»).
 *
 * Прогон 4 (16.10): первая партия — attempted 5, принято 0 (роут ответил 502),
 * и workflow вышел на ней же: остальные 11 партий не шли, очередь стояла.
 * 502 роута при attempted > 0 — не обрыв прогона, а партия без принятых
 * полей: её поля уходят в skip, следующая партия берёт поля за ними.
 *
 * Что держится:
 *   - 502 с attempted > 0 — цикл идёт дальше, skip растёт на непринятые;
 *   - ни одного принятого поля за весь боевой прогон при непустой очереди —
 *     красный (§4.0: ноль при ненулевом входе — не «хорошо»);
 *   - 500, 502 без attempted (шлюз), 000 (сеть), 200 не от роута — красный
 *     и обрыв на этой партии;
 *   - итог по всем партиям (принято / отклонено / осталось) — в сводке шага;
 *   - сухой прогон — одна партия, зелёный.
 * Маркер берётся из временного каталога: настоящий .github/triggers не трогается.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, stepByName } from '../helpers/workflow-semantics';

const wf = loadWorkflow('.github/workflows/zh-translate.yml');
const step = stepByName(wf.jobs['translate'], 'Перевод партиями');

// curl отвечает k-й партии файлами k.code / k.json; «neterr» — запрос не дошёл.
const CURL_STUB = `#!/usr/bin/env bash
out=""; wfmt=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    -H|--max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
n=$(( $(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_DIR/n"
printf '%s\\n' "$url" >> "$FAKE_DIR/curl.log"
code=$(cat "$FAKE_DIR/$n.code" 2>/dev/null || echo 599)
if [ "$code" = "neterr" ]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
body=$(cat "$FAKE_DIR/$n.json" 2>/dev/null || echo '{}')
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0
`;

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'zh-translate-wf-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

interface Reply { code: string; body: unknown }
interface Run { code: number; out: string; urls: string[]; summary: string }

const field = (i: number) => ({ entity_type: 'tour', entity_id: String(i), field: 'description' });

/** Ответ роута в боевом режиме: столько-то принято и отклонено из очереди. */
function applyReply(o: { pending: number; ok: number; rejected: number }): Reply {
  const attempted = o.ok + o.rejected;
  const failed = attempted > 0 && o.ok === 0;
  return {
    code: failed ? '502' : '200',
    body: {
      ok: !failed,
      mode: 'apply',
      pending: o.pending,
      attempted,
      translated: Array.from({ length: o.ok }, (_, i) => field(i)),
      not_translated: Array.from({ length: o.rejected }, (_, i) => ({ ...field(100 + i), reason: 'сегмент 1: в переводе появились числа, которых нет в исходнике: 2' })),
      pending_left: o.pending - o.ok,
    },
  };
}

function run(marker: unknown, replies: Reply[]): Run {
  const dir = mkdtempSync(join(work, 'run-'));
  const fake = join(dir, 'fake');
  mkdirSync(fake);
  mkdirSync(join(dir, '.github', 'triggers'), { recursive: true });
  writeFileSync(join(dir, '.github', 'triggers', 'zh-translate.json'), JSON.stringify(marker));
  replies.forEach((r, i) => {
    writeFileSync(join(fake, `${i + 1}.code`), r.code);
    writeFileSync(join(fake, `${i + 1}.json`), typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  const summary = join(dir, 'summary.md');
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? dir,
    FAKE_DIR: fake,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: dir,
    CRON_SECRET: 'test-secret',
  };
  let code = 0;
  let out = '';
  try {
    // Так GitHub исполняет run: без указанного shell на ubuntu.
    out = execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run ?? ''], {
      cwd: dir, env, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const log = join(fake, 'curl.log');
  return {
    code,
    out,
    urls: existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [],
    summary: existsSync(summary) ? readFileSync(summary, 'utf-8') : '',
  };
}

const skipOf = (url: string) => new URL(url).searchParams.get('skip');

describe('партия без принятых полей не обрывает прогон', () => {
  it('502 с attempted > 0 — цикл идёт дальше, skip растёт на непринятые, итог по всем партиям', () => {
    const r = run({ mode: 'apply', batches: 3 }, [
      applyReply({ pending: 12, ok: 0, rejected: 5 }),
      applyReply({ pending: 12, ok: 3, rejected: 2 }),
      applyReply({ pending: 9, ok: 5, rejected: 0 }),
    ]);
    expect(r.code).toBe(0);
    expect(r.urls).toHaveLength(3);
    expect(r.urls.map(skipOf)).toEqual(['0', '5', '7']);
    expect(r.out).toContain('::warning::партия 1: не принято ни одно из 5 полей');
    expect(r.summary).toContain('принято полей 8, отклонено 7, осталось в очереди 4');
  });

  it('ни одного принятого поля за весь боевой прогон — красный, но все партии прошли', () => {
    const r = run({ mode: 'apply', batches: 3 }, [
      applyReply({ pending: 15, ok: 0, rejected: 5 }),
      applyReply({ pending: 15, ok: 0, rejected: 5 }),
      applyReply({ pending: 15, ok: 0, rejected: 5 }),
    ]);
    expect(r.code).not.toBe(0);
    expect(r.urls.map(skipOf)).toEqual(['0', '5', '10']);
    expect(r.out).toContain('::error::за прогон не принято ни одного поля из очереди 15');
    expect(r.summary).toContain('принято полей 0, отклонено 15, осталось в очереди 15');
  });

  it('очередь кончилась на непереводимых полях после принятых — зелёный с предупреждением', () => {
    const r = run({ mode: 'apply', batches: 5 }, [
      applyReply({ pending: 7, ok: 2, rejected: 3 }),
      applyReply({ pending: 5, ok: 0, rejected: 2 }),
      { code: '200', body: { ok: true, mode: 'apply', pending: 5, attempted: 0, translated: [], not_translated: [], pending_left: 5 } },
    ]);
    expect(r.code).toBe(0);
    expect(r.urls.map(skipOf)).toEqual(['0', '3', '5']);
    expect(r.out).toContain('в очереди остались только поля, которые в этом прогоне не перевелись (5)');
    expect(r.summary).toContain('принято полей 2, отклонено 5, осталось в очереди 5');
  });

  it('всё переведено — цикл кончается раньше лимита, зелёный', () => {
    const r = run({ mode: 'apply', batches: 4 }, [
      applyReply({ pending: 5, ok: 5, rejected: 0 }),
    ]);
    expect(r.code).toBe(0);
    expect(r.urls).toHaveLength(1);
    expect(r.out).toContain('переводить больше нечего');
  });
});

describe('роут партию не отработал — красный и обрыв', () => {
  it('500 базы после принятой партии — красный, дальше не идём, итог есть', () => {
    const r = run({ mode: 'apply', batches: 4 }, [
      applyReply({ pending: 20, ok: 4, rejected: 1 }),
      { code: '500', body: { ok: false, error: 'база не прочитана', sqlstate: '57P01' } },
    ]);
    expect(r.code).not.toBe(0);
    expect(r.urls).toHaveLength(2);
    expect(r.out).toContain('::error::партия 2: HTTP 500');
    expect(r.summary).toContain('принято полей 4, отклонено 1, осталось в очереди 16');
  });

  it('502 без attempted — это шлюз перед роутом, а не партия без перевода: красный', () => {
    const r = run({ mode: 'apply', batches: 3 }, [
      { code: '502', body: '<html><body>502 Bad Gateway</body></html>' },
    ]);
    expect(r.code).not.toBe(0);
    expect(r.urls).toHaveLength(1);
    expect(r.out).toContain('::error::партия 1: HTTP 502');
  });

  it('502 роута с attempted 0 — тоже не партия без перевода: красный', () => {
    const r = run({ mode: 'apply', batches: 3 }, [
      { code: '502', body: { ok: false, pending: 3, attempted: 0, translated: [], not_translated: [], pending_left: 3 } },
    ]);
    expect(r.code).not.toBe(0);
    expect(r.urls).toHaveLength(1);
  });

  it('запрос не дошёл (000) — красный', () => {
    const r = run({ mode: 'apply', batches: 3 }, [{ code: 'neterr', body: '' }]);
    expect(r.code).not.toBe(0);
    expect(r.urls).toHaveLength(1);
    expect(r.out).toContain('::error::партия 1: HTTP 000');
  });

  it('200, но не ответ роута — красный, а не «очередь пуста»', () => {
    const r = run({ mode: 'apply', batches: 3 }, [{ code: '200', body: '<html>заглушка</html>' }]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('нет счёта очереди');
  });
});

describe('сухой прогон', () => {
  it('одна партия, модель не зовётся, зелёный со счётом очереди', () => {
    const r = run({ mode: 'dry', batches: 6 }, [
      { code: '200', body: { ok: true, mode: 'dry', pending: 106, pending_sample: [] } },
    ]);
    expect(r.code).toBe(0);
    expect(r.urls).toHaveLength(1);
    expect(new URL(r.urls[0]).searchParams.get('apply')).toBe('0');
    expect(r.summary).toContain('Итог сухого прогона: в очереди 106 полей');
  });
});
