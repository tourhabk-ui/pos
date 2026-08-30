/**
 * «Не знаю» — не «не доехало». Три исхода проверки выкладки, а не два.
 *
 * Аудит 30.08 замерил: с 20.08 (последний зелёный — run 1128) ни одного
 * успешного прогона деплоя, при живой выкладке — владелец видел на проде
 * изменения только что смерженных PR. Каждый прогон падал одинаково: сайт
 * отдавал `/version.json` со значением `unknown`, и шаг объявлял ФАКТОМ
 * «Контейнер не переключился».
 *
 * `unknown` пишет наш собственный маркер (scripts/write-version.js), когда не
 * смог разрешить sha по файлам .git, и шапка того же скрипта требует дословно:
 * «проверка деплоя обязана трактовать его как „не смог подтвердить“, а не как
 * „не доехало“». Файл и проверка противоречили друг другу в письменном виде,
 * а два разных факта — «сайт назвал ЧУЖОЙ коммит» и «сайт сказал „не знаю“» —
 * схлопывались в один вердикт.
 *
 * Цена была не только в шуме. Шаг падал ДО смоука, поэтому «Production smoke»
 * не выполнялся ни разу за эти десять дней: ложная тревога глушила
 * единственную проверку «задеплоено ≠ работает», ради которой смоук и заведён
 * (15-16.08, прод с мёртвым выбором маршрута при зелёной сборке).
 *
 * Проверяется ИСПОЛНЕНИЕМ, а не регулярками — тем же приёмом, что
 * deploy-ancestry.test.ts: регулярка подтвердит, что строка написана, но не
 * то, что развилка ведёт куда обещано, а ошибка была именно в поведении.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEPLOY = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf-8');

/** Тело развилки вердикта из workflow — проверяем поставляемый код, не копию. */
function extractVerdict(): string {
  const start = DEPLOY.indexOf('if [ -n "$SERVED_OK" ]; then');
  expect(start, 'развилки вердикта нет в deploy.yml').toBeGreaterThan(-1);
  const rest = DEPLOY.slice(start);
  const end = rest.indexOf('\n          fi');
  expect(end, 'не найден конец развилки').toBeGreaterThan(-1);
  return rest.slice(0, end + '\n          fi'.length)
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n');
}

let repo: string;
let livingSha: string;   // коммит, существующий в клоне
let expectedSha: string; // «наш» коммит из другой линии

function git(args: string[], cwd = repo): string {
  return execFileSync('git', ['-c', 'color.ui=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

interface Outcome { code: number; out: string }

/** Запускает развилку из workflow с заданным состоянием. */
function verdict(vars: Record<string, string>): Outcome {
  const env = Object.entries(vars)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
  const script = `${env}\n${extractVerdict()}`;
  try {
    const out = execFileSync('bash', ['-c', script], { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'deploy-unknown-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  git(['add', 'f.txt']);
  git(['commit', '-q', '-m', 'a']);
  livingSha = git(['rev-parse', 'HEAD']);
  // Отдельная линия: наш коммит в предках livingSha не значится.
  git(['checkout', '-q', '--orphan', 'other']);
  writeFileSync(join(repo, 'g.txt'), 'b\n');
  git(['add', 'g.txt']);
  git(['commit', '-q', '-m', 'b']);
  expectedSha = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('исход «подтверждено»', () => {
  it('сайт назвал наш коммит — зелёный и внятная формулировка', () => {
    const r = verdict({ SERVED_OK: '1', SERVED: livingSha, REASON: 'ok', COMMIT: livingSha, EXPECTED_SHA: expectedSha });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Деплой подтверждён фактом/);
  });
});

describe('исход «не смог подтвердить» — третье состояние (§4.0)', () => {
  // Ровно те 238 прогонов: маркер честно сказал «не знаю», а шаг объявлял
  // фактом «контейнер не переключился».
  it('unknown НЕ выдаётся за «не доехало» и не роняет прогон', () => {
    const r = verdict({ SERVED_OK: '', SERVED: 'unknown', REASON: 'no_git_head', COMMIT: livingSha, EXPECTED_SHA: expectedSha });
    expect(r.code, 'третье состояние не имеет права ронять шаг — за ним стоит смоук').toBe(0);
    expect(r.out).toMatch(/НЕ СМОГЛИ ПОДТВЕРДИТЬ/);
    expect(r.out, 'претензия на факт при незнании — исходный дефект').not.toMatch(/Контейнер не переключился/);
    expect(r.out).not.toMatch(/::error::/);
  });

  it('причина маркера доезжает до прогона — лог сборки Timeweb читать не нужно', () => {
    const r = verdict({ SERVED_OK: '', SERVED: 'unknown', REASON: 'ref_not_in_packed', COMMIT: livingSha, EXPECTED_SHA: expectedSha });
    expect(r.out).toMatch(/ref_not_in_packed/);
  });

  it('пустой ответ сайта — тоже «не смог», а не «не доехало»', () => {
    const r = verdict({ SERVED_OK: '', SERVED: '', REASON: '', COMMIT: livingSha, EXPECTED_SHA: expectedSha });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/НЕ СМОГЛИ ПОДТВЕРДИТЬ/);
    expect(r.out).not.toMatch(/::error::/);
  });

  it('коммит есть, но его нет в клоне — родство установить нечем, значит «не знаю»', () => {
    // Тот же класс на уровень ниже: contains_expected возвращает 1 и когда
    // родства нет, и когда объект не достался. Выдавать второе за первое —
    // тот же дефект, что чинится выше.
    const r = verdict({
      SERVED_OK: '', SERVED: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      REASON: 'ok', COMMIT: livingSha, EXPECTED_SHA: expectedSha,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/НЕ СМОГЛИ ПОДТВЕРДИТЬ/);
    expect(r.out).not.toMatch(/::error::/);
  });
});

describe('исход «не доехало» — строгость сохранена', () => {
  it('живой чужой коммит по-прежнему красит прогон', () => {
    // Ослаблена точность формулировки, а не строгость проверки: откат и
    // застрявшая сборка выглядят именно так и обязаны оставаться красными.
    const r = verdict({
      SERVED_OK: '', SERVED: livingSha, REASON: 'ok',
      COMMIT: livingSha, EXPECTED_SHA: expectedSha,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::/);
    expect(r.out, 'здесь утверждение о факте верно — сайт назвал живой чужой коммит')
      .toMatch(/Контейнер не переключился/);
  });

  it('короткая форма sha судится как коммит, а не как «не знаю»', () => {
    // /version.json и панель Timeweb могут отдать сокращённый sha — это
    // ИМЯ коммита, и оно обязано попасть в ветку родства, а не в третье
    // состояние (иначе настоящий откат стал бы предупреждением).
    const r = verdict({
      SERVED_OK: '', SERVED: livingSha.slice(0, 12), REASON: 'ok',
      COMMIT: livingSha, EXPECTED_SHA: expectedSha,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Контейнер не переключился/);
  });
});

describe('смоук достижим', () => {
  it('шаг смоука стоит после сверки и ничем не отключён', () => {
    // Смоук не помечен `if:` — он идёт всегда, когда сверка не вышла с 1.
    // На настоящем расхождении шаг падает, и смоук пропускается по делу:
    // проверять старый контейнер бессмысленно.
    const verify = DEPLOY.indexOf('Verify deploy reached production');
    const smoke = DEPLOY.indexOf('node scripts/deploy-smoke.mjs');
    expect(smoke).toBeGreaterThan(verify);
    const between = DEPLOY.slice(DEPLOY.indexOf('Production smoke', verify), smoke);
    expect(between, 'смоук не должен быть за условием — он и так за сверкой').not.toMatch(/^\s+if:/m);
  });
});
