// @vitest-environment node
/**
 * Проба: адрес, который правка прячет, ждёт 404, а не 200 (15.10, поле gone).
 *
 * Шаг пробы считал любой 404 «ещё не выкатилось» и повторял его retries раз.
 * Для адреса, который правка СКРЫВАЕТ, 404 — и есть искомый ответ: проба 965
 * повторяла 404 скрытого «Кордона озеро Паланское» семьдесят раз по 45 секунд,
 * и до карточек после него дошла бы через час. Поле gone называет такие
 * адреса: 404 у них — исход «скрыт», иной ответ сайта — «снятие ещё не
 * доехало», и ждать надо его.
 *
 * Сторож судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10): настоящий bash шага «Fetch and
 * print» из probe-url.yml с подложенным curl, который отвечает заготовленной
 * последовательностью кодов на каждый адрес и пишет журнал вызовов. Пути
 * /tmp/ шага переносятся во временный каталог — больше в скрипте не меняется
 * ничего.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadWorkflow, stepByName } from '../helpers/workflow-semantics';

const STEP = stepByName(loadWorkflow('.github/workflows/probe-url.yml').jobs.probe, 'Fetch and print');

const CURL_STUB = `#!/usr/bin/env bash
out=""; hdr=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -D) hdr="$2"; shift 2;;
    -w|-A|-H|-r|-X|--max-time|--data-binary) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
echo "$url" >> "$FAKE_DIR/calls.log"
key=$(printf '%s' "$url" | md5sum | cut -c1-12)
n=$(cat "$FAKE_DIR/$key.n" 2>/dev/null || echo 0)
total=$(wc -l < "$FAKE_DIR/$key.seq")
line=$(( n < total ? n + 1 : total ))
code=$(sed -n "\${line}p" "$FAKE_DIR/$key.seq")
echo $((n + 1)) > "$FAKE_DIR/$key.n"
printf 'HTTP/2 %s\\r\\ncontent-type: application/json\\r\\n\\r\\n' "$code" > "$hdr"
printf '{"code":%s}' "$code" > "$out"
printf '%s' "$code"
`;

const keyOf = (url: string) => createHash('md5').update(url).digest('hex').slice(0, 12);

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'probe-gone-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

let n = 0;
/** Прогон шага: конфиг пробы и коды ответа по адресам (последний повторяется). */
function runProbe(config: Record<string, unknown>, codes: Record<string, number[]>) {
  const dir = join(root, `run${n++}`);
  const fake = join(dir, 'fake');
  const bin = join(dir, 'bin');
  const tmp = join(dir, 'tmp');
  for (const d of [fake, bin, tmp, join(dir, '.github/triggers')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
  for (const [url, seq] of Object.entries(codes)) writeFileSync(join(fake, `${keyOf(url)}.seq`), seq.join('\n') + '\n');
  writeFileSync(join(dir, '.github/triggers/probe-url.json'), JSON.stringify({ retryDelay: 0, ...config }));
  writeFileSync(join(dir, 'step.sh'), STEP.run!.replaceAll('/tmp/', `${tmp}/`));
  const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: fake, CRON_SECRET: 'x' },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const log = join(fake, 'calls.log');
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const A = 'https://vedarai.ru/api/places/aaaaaaaa';
const HIDDEN = 'https://vedarai.ru/api/places/c23dd150';
const B = 'https://vedarai.ru/api/places/bbbbbbbb';

describe('probe-url: gone — 404 как искомый ответ', () => {
  it('скрытый адрес отвечает 404 сразу — без повторов, проба зелёная и идёт дальше', () => {
    const r = runProbe({ urls: [A, HIDDEN, B], gone: [HIDDEN], retries: 5 }, { [A]: [200], [HIDDEN]: [404], [B]: [200] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([A, HIDDEN, B]);
    expect(r.out).toContain('404 — искомый ответ: адрес скрыт (gone)');
  });

  it('пока скрытый адрес ещё отвечает 200 — ждём, а не принимаем', () => {
    const r = runProbe({ urls: [HIDDEN, B], gone: [HIDDEN], retries: 3 }, { [HIDDEN]: [200, 200, 404], [B]: [200] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([HIDDEN, HIDDEN, HIDDEN, B]);
    expect(r.out).toContain('адрес ещё отвечает, ждём 404');
  });

  it('снятие так и не доехало — проба красная и называет адрес', () => {
    const r = runProbe({ urls: [HIDDEN], gone: [HIDDEN], retries: 2 }, { [HIDDEN]: [200] });
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(3);
    expect(r.out).toMatch(/ПРОБА НЕ УДАЛАСЬ: GET https:\/\/vedarai\.ru\/api\/places\/c23dd150: код 200 — адрес ещё отвечает, ждём 404/);
  });

  it('перезапуск контейнера у скрытого адреса — не «скрыт»: 502 повторяется', () => {
    const r = runProbe({ urls: [HIDDEN], gone: [HIDDEN], retries: 2 }, { [HIDDEN]: [502, 404] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([HIDDEN, HIDDEN]);
  });

  it('без gone 404 по-прежнему «ещё не выкатилось»: повтор и красная проба', () => {
    const r = runProbe({ urls: [HIDDEN], retries: 1 }, { [HIDDEN]: [404] });
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.out).not.toContain('адрес скрыт (gone)');
  });

  it('адрес из gone, которого нет в urls, — отказ до первого запроса', () => {
    const r = runProbe({ urls: [A], gone: [HIDDEN], retries: 1 }, { [A]: [200] });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(`адрес из gone не стоит в urls: ${HIDDEN}`);
  });
});
