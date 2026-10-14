// @vitest-environment node
/**
 * Надзор за Next в start.js (14.10) — вызовом и запуском, а не чтением.
 *
 * До 14.10 Next запускался голым spawn, а /api/health прокси отвечал 200
 * безусловно. Умри Next — контейнер выглядел здоровым, а сайт и задачи
 * SAFETY_JOBS стояли бы до следующего выката. Сторож держит обе половины:
 *
 *  1. правило — createNextSupervisor из start.js на граничных данных:
 *     перезапуск с растущей паузой, петля падений, честный ответ здоровья,
 *     остановка без перезапуска;
 *  2. проводку — настоящий start.js с подставным server.js: убитый Next
 *     поднимается сам, здоровье говорит правду, клиента не держат над
 *     оборванным ответом, SIGTERM доходит до Next.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START = join(process.cwd(), 'start.js');
const BLOCK = readFileSync(START, 'utf8').match(/\/\/ <nextSupervisor>([\s\S]*?)\/\/ <\/nextSupervisor>/)?.[1] ?? '';

interface LastExit { code: number | null; signal: string | null; lived_s: number; at: string }
interface Health {
  status: number;
  body: { status: string; next: { state: string; uptime_s: number | null; restarts: number; last_exit: LastExit | null } };
}
interface Supervisor { start(): void; stop(signal: string): void; health(): Health }
interface Deps {
  spawnChild: () => FakeChild;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  log: (m: string) => void;
  onStopped: () => void;
}

const createNextSupervisor = new Function(`${BLOCK}; return createNextSupervisor;`)() as (deps: Deps) => Supervisor;

class FakeChild extends EventEmitter {
  readonly kill = vi.fn((_signal: string) => true);
  constructor(readonly pid: number | undefined) { super(); }
  die(code: number | null, signal: string | null = null): void { this.emit('exit', code, signal); }
}

function rig(pids: Array<number | undefined> = []) {
  const children: FakeChild[] = [];
  const log = vi.fn<(m: string) => void>();
  const onStopped = vi.fn<() => void>();
  const sup = createNextSupervisor({
    spawnChild: () => {
      const c = new FakeChild(children.length < pids.length ? pids[children.length] : 1000 + children.length);
      children.push(c);
      return c;
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    now: () => Date.now(),
    log,
    onStopped,
  });
  return { sup, children, log, onStopped };
}

const SEC = 1000;

describe('правило надзора (createNextSupervisor из start.js)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('блок лежит между маркерами', () => {
    expect(BLOCK).toContain('function createNextSupervisor');
  });

  it('пока Next запускается — 200; живой — 200 со своим аптаймом', () => {
    const { sup, children } = rig();
    expect(sup.health().status).toBe(200);
    expect(sup.health().body.next.state).toBe('starting');
    sup.start();
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(90 * SEC);
    const h = sup.health();
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'ok', next: { state: 'running', uptime_s: 90, restarts: 0, last_exit: null } });
  });

  it('Next убит после долгой жизни — 503, пока лежит, через секунду поднят заново', () => {
    const { sup, children, log } = rig();
    sup.start();
    vi.advanceTimersByTime(10 * 60 * SEC);
    children[0].die(null, 'SIGKILL');

    const down = sup.health();
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ status: 'down', next: { state: 'down', uptime_s: null, restarts: 1 } });
    expect(down.body.next.last_exit).toMatchObject({ code: null, signal: 'SIGKILL', lived_s: 600 });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/\[next\] .*SIGKILL.*перезапуск №1 через 1000 мс/);

    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    expect(sup.health()).toMatchObject({ status: 200, body: { next: { state: 'running', restarts: 1 } } });
  });

  it('быстрые падения: пауза растёт, после трёх — петля падений и 503 даже у запущенного', () => {
    const { sup, children } = rig();
    sup.start();
    for (const [i, pause] of [[0, 2], [1, 4], [2, 8]] as const) {
      vi.advanceTimersByTime(SEC);
      children[i].die(1);
      vi.advanceTimersByTime(pause * SEC - 1);
      expect(children, `после падения №${i + 1} пауза ${pause} с`).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(children).toHaveLength(i + 2);
    }
    // Четвёртый процесс жив, но три быстрых выхода подряд — его «ok» был бы
    // ставкой, а не знанием.
    expect(sup.health()).toMatchObject({ status: 503, body: { status: 'down', next: { state: 'crash_loop', restarts: 3 } } });

    // Прожил минуту — петля кончилась.
    vi.advanceTimersByTime(60 * SEC);
    expect(sup.health()).toMatchObject({ status: 200, body: { next: { state: 'running' } } });

    // И выход после долгой жизни снова считается первым: пауза секунда.
    children[3].die(1);
    vi.advanceTimersByTime(SEC);
    expect(children).toHaveLength(5);
  });

  it('пауза растёт не выше 30 с', () => {
    const { sup, children } = rig();
    sup.start();
    for (let i = 0; i < 6; i++) {
      children[i].die(1);
      vi.advanceTimersByTime(30 * SEC);
    }
    expect(children).toHaveLength(7);
    children[6].die(1);
    vi.advanceTimersByTime(30 * SEC - 1);
    expect(children).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(8);
  });

  it('остановка: сигнал уходит Next, выход — когда Next вышел, перезапуска нет', () => {
    const { sup, children, onStopped } = rig();
    sup.start();
    vi.advanceTimersByTime(5 * 60 * SEC);
    sup.stop('SIGTERM');
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(sup.health()).toMatchObject({ status: 503, body: { next: { state: 'stopping' } } });
    expect(onStopped).not.toHaveBeenCalled();

    children[0].die(0);
    expect(onStopped).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * SEC);
    expect(children).toHaveLength(1);

    sup.stop('SIGTERM');
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('остановка во время паузы перед перезапуском — выход сразу, перезапуска нет', () => {
    const { sup, children, onStopped } = rig();
    sup.start();
    children[0].die(1);
    sup.stop('SIGTERM');
    expect(onStopped).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * SEC);
    expect(children).toHaveLength(1);
  });

  it('процесс не запустился вовсе — это выход; «error» и «exit» вместе дают один перезапуск', () => {
    const { sup, children, log } = rig([undefined]);
    sup.start();
    children[0].emit('error', new Error('spawn node EAGAIN'));
    children[0].die(null);
    expect(log.mock.calls.some(([m]) => m.includes('spawn node EAGAIN'))).toBe(true);
    vi.advanceTimersByTime(60 * SEC);
    expect(children).toHaveLength(2);
    expect(sup.health().body.next.restarts).toBe(1);
  });
});

// ── Проводка: настоящий start.js ──────────────────────────────────────────
//
// Порт Next (3001) в start.js записан жёстко: на него смотрят прокси, задачи
// SAFETY_JOBS и прогрев планов. Подставной server.js садится туда же.

const FAKE_SERVER = `
const http = require('http');
const fs = require('fs');
fs.appendFileSync('starts.log', process.pid + '\\n');
process.on('SIGTERM', () => { fs.appendFileSync('signals.log', 'SIGTERM\\n'); process.exit(0); });
http.createServer((req, res) => {
  if (req.url === '/die-mid-response') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    setTimeout(() => process.exit(1), 50);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('next ok');
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

interface Reply { status: number; body: string }

function get(port: number, path: string, timeoutMs = 2000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

/** Чем кончился ответ: дописан, оборван или повис. */
function outcome(port: number, path: string, hangMs: number): Promise<'complete' | 'cut' | 'hung'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { r.destroy(); resolve('hung'); }, hangMs);
    const done = (v: 'complete' | 'cut') => { clearTimeout(timer); resolve(v); };
    const r = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.on('data', () => undefined);
      res.on('end', () => done(res.complete ? 'complete' : 'cut'));
      res.on('error', () => done('cut'));
      res.on('close', () => { if (!res.complete) done('cut'); });
    });
    r.on('error', () => done('cut'));
    r.end();
  });
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface HealthBody { status: string; uptime_s: number; next: { state: string; restarts: number; last_exit: LastExit | null } }

function parseHealth(r: Reply): HealthBody {
  return JSON.parse(r.body) as HealthBody;
}

describe('настоящий start.js с подставным server.js', () => {
  let dir = '';
  let port = 0;
  let proc: ChildProcess | null = null;
  let output = '';
  let exited: Promise<{ code: number | null; signal: string | null }> = Promise.resolve({ code: null, signal: null });

  const starts = () => readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length;

  beforeAll(async () => {
    expect(await portIsFree(3001), 'порт 3001 занят — start.js держит Next жёстко на нём').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'start-js-'));
    copyFileSync(START, join(dir, 'start.js'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/migrate-standalone.js'), 'process.exit(0);\n');
    writeFileSync(join(dir, 'server.js'), FAKE_SERVER);
    port = await freePort();

    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
    // Без секрета задачи SAFETY_JOBS не ставятся — тест судит прокси и надзор.
    delete env.CRON_SECRET;
    proc = spawn(process.execPath, ['start.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
    const p = proc;
    exited = new Promise((resolve) => p.once('exit', (code, signal) => resolve({ code, signal })));
  }, 20_000);

  afterAll(() => {
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    // Подставной Next, переживший start.js (упавший тест), держал бы порт 3001
    // для следующего прогона: его pid записан при старте.
    if (dir && existsSync(join(dir, 'starts.log'))) {
      for (const pid of readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').map(Number)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; // ESRCH — уже вышел
        }
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('Next поднят за прокси, здоровье — 200 и называет состояние Next', async () => {
    const hello = await waitFor(async () => {
      const r = await get(port, '/hello');
      return r.status === 200 ? r : null;
    }, 10_000, `ответ Next через прокси; вывод start.js:\n${output}`);
    expect(hello.body).toBe('next ok');

    const h = await get(port, '/api/health');
    expect(h.status).toBe(200);
    expect(parseHealth(h)).toMatchObject({ status: 'ok', next: { state: 'running', restarts: 0, last_exit: null } });
    expect(typeof parseHealth(h).uptime_s).toBe('number');
  }, 15_000);

  it('Next умер посреди ответа — клиенту рвут соединение, а не держат над ним', async () => {
    // До 14.10 (pipe) клиент ждал над недописанным ответом до своего таймаута.
    expect(await outcome(port, '/die-mid-response', 3000)).toBe('cut');
  }, 10_000);

  it('пока Next лежит — 503 «down»; затем он поднят сам, и здоровье снова 200', async () => {
    const seen: string[] = [];
    const back = await waitFor(async () => {
      const r = await get(port, '/api/health');
      const body = parseHealth(r);
      seen.push(`${r.status}:${body.next.state}`);
      return r.status === 200 && body.next.restarts === 1 ? body : null;
    }, 10_000, 'Next не поднят заново');
    expect(seen, 'промежуток без Next здоровье обязано назвать').toContain('503:down');
    expect(back.next.last_exit).toMatchObject({ code: 1, signal: null });
    // «running» — процесс запущен; слушает ли он порт, здоровье не судит (так
    // и при первом старте), поэтому сам ответ Next ждём отдельно.
    await waitFor(async () => {
      const r = await get(port, '/hello');
      return r.body === 'next ok' ? r : null;
    }, 10_000, 'Next после перезапуска не ответил');
    expect(starts()).toBe(2);
  }, 15_000);

  it('SIGTERM доходит до Next, start.js выходит сам и Next не поднимает', async () => {
    proc?.kill('SIGTERM');
    const end = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
    ]);
    expect(end, `start.js не вышел за 9 с; вывод:\n${output}`).not.toBeNull();
    expect(end).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dir, 'signals.log')) && readFileSync(join(dir, 'signals.log'), 'utf8')).toBe('SIGTERM\n');
    expect(starts()).toBe(2);
  }, 15_000);
});
