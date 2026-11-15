/**
 * Образец голоса DeepSeek владельцу в Telegram (слово владельца 15.11
 * «deepseek добавили голос»): scripts/voice-sample.sh исполняется настоящим
 * bash, curl и ffmpeg подменены.
 *
 * Держит:
 *  - оба голоса синтезируются вшитой фразой и уходят голосовыми сообщениями
 *    владельцу; итог называет, сколько ушло;
 *  - нет ключа или адресата — красный с причиной, в сеть не ходит;
 *  - DeepSeek отказал одному голосу или Telegram не принял — красный, причина
 *    названа, второй голос всё равно уходит;
 *  - ключ и токен не печатаются;
 *  - workflow зовёт этот скрипт по маркеру и отдаёт ему секреты окружением.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'voice-sample.sh');
const KEY = 'sk-test-deepseek-key-0000';
const TOKEN = '123456:test-telegram-token';

const CURL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
out=""; url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -F|-H|-w|-X|--max-time) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *api.deepseek.com*)
    voice=$(printf '%s' "$data" | jq -r .voice_id)
    printf '%s\\n' "$data" >> "$BODIES"
    code_var="DS_CODE_$voice"; code="\${!code_var:-200}"
    if [ "$code" = 200 ]; then head -c 5000 /dev/zero > "$out"; else printf '{"error":"denied"}' > "$out"; fi
    printf '%s' "$code" ;;
  *api.telegram.org*)
    printf '%s' "$TG_BODY" > "$out"
    printf '%s' "$TG_CODE" ;;
  *) printf '000'; exit 7 ;;
esac
`;

const FFMPEG_STUB = `#!/usr/bin/env bash
for a; do last="$a"; done
printf 'ogg' > "$last"
`;

let dir: string;

function run(env: Record<string, string>) {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      CALLS: join(dir, 'calls.log'),
      BODIES: join(dir, 'bodies.log'),
      OUT_DIR: join(dir, 'out'),
      TG_CODE: '200',
      TG_BODY: '{"ok":true}',
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return { code: res.status, out: `${res.stdout}${res.stderr}`, calls: read('calls.log'), bodies: read('bodies.log') };
}

const SECRETS = { DEEPSEEK_API_KEY: KEY, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: '42' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-sample-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  writeFileSync(join(bin, 'ffmpeg'), FFMPEG_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'ffmpeg'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('образец уходит владельцу', () => {
  it('оба голоса: синтез вшитой фразы и голосовое сообщение владельцу; итог назван', () => {
    const r = run(SECRETS);
    expect(r.code, r.out).toBe(0);
    const bodies = r.bodies.trim().split('\n').map((l) => JSON.parse(l) as { text: string; voice_id: string; format: string });
    expect(bodies.map((b) => b.voice_id)).toEqual(['stella', 'tide']);
    for (const b of bodies) {
      expect(b.format).toBe('wav');
      expect(b.text).toContain('Экстренный вызов — 112');
      expect(b.text).toContain('МЧС');
    }
    const sends = r.calls.split('\n').filter((l) => l.includes('sendVoice'));
    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s).toContain('chat_id=42');
      expect(s).toMatch(/voice=@.*\.ogg/);
    }
    expect(r.out).toContain('Итог: отправлено 2 из 2.');
  });

  it('ключ и токен в вывод не попадают', () => {
    const r = run({ ...SECRETS, DS_CODE_tide: '403', TG_BODY: '{"ok":false,"description":"Bad Request"}' });
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain(TOKEN);
  });
});

describe('отказ — красный с причиной', () => {
  it('нет ключа DeepSeek — в сеть не ходит', () => {
    const r = run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: '42' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('DEEPSEEK_API_KEY не задан');
    expect(r.calls).toBe('');
  });

  it('некуда отправить — в сеть не ходит', () => {
    const r = run({ DEEPSEEK_API_KEY: KEY });
    expect(r.code).toBe(1);
    expect(r.out).toContain('TELEGRAM_OWNER_ID не заданы');
    expect(r.calls).toBe('');
  });

  it('DeepSeek отказал одному голосу — причина названа, второй ушёл', () => {
    const r = run({ ...SECRETS, DS_CODE_tide: '403' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('голос tide: DeepSeek звука не дал (HTTP 403');
    expect(r.out).toContain('голос stella: ушёл владельцу в Telegram');
    expect(r.out).toContain('Итог: отправлено 1 из 2.');
  });

  it('Telegram не принял — красный, а не «ушло»', () => {
    const r = run({ ...SECRETS, TG_BODY: '{"ok":false,"description":"Bad Request: chat not found"}' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Telegram не принял сообщение');
    expect(r.out).toContain('chat not found');
    expect(r.out).toContain('Итог: отправлено 0 из 2.');
  });
});

describe('workflow', () => {
  const WF = readFileSync(join(ROOT, '.github/workflows/voice-sample.yml'), 'utf8');

  it('идёт по маркеру и зовёт этот скрипт', () => {
    expect(WF).toContain("- '.github/triggers/voice-sample.json'");
    expect(WF).toContain('run: bash scripts/voice-sample.sh');
    expect(existsSync(join(ROOT, '.github/triggers/voice-sample.json'))).toBe(true);
  });

  it('секреты — окружением шага, не строкой команды', () => {
    for (const s of ['DEEPSEEK_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID']) {
      expect(WF).toContain(`${s}: \${{ secrets.${s} }}`);
    }
    expect(WF).not.toMatch(/run:.*secrets\./);
  });
});
