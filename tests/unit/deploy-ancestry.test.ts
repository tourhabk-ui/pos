/**
 * Публикация подтверждается предками, и это проверяется исполнением.
 *
 * 16.08 деплой покраснел, хотя прод уже содержал фикс: Timeweb собирает
 * голову ветки, а не конкретный коммит, и собрал потомка — авто-коммит
 * счётчиков README лёг в main через секунды после мержа. Проверка требовала
 * точного совпадения SHA, двадцать минут ждала того, что уже произошло, и
 * упала. Хуже: следом за ней стоит смоук по проду, поэтому здоровье продукта
 * вообще не проверялось.
 *
 * Здесь берётся ТА ЖЕ функция `contains_expected` из deploy.yml и
 * выполняется на синтетическом репозитории. Проверять текст workflow
 * регулярками мало: они подтвердят, что строка написана, но не то, что она
 * работает — а ошибка была именно в поведении.
 *
 * История синтетическая намеренно: в CI клон мелкий (fetch-depth по
 * умолчанию), и тест на настоящих коммитах репозитория падал бы не от
 * дефекта, а от отсутствия истории.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEPLOY = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf-8');

/** Достаём тело функции из workflow — проверяем поставляемый код, не копию. */
function extractFn(): string {
  const start = DEPLOY.indexOf('contains_expected() {');
  expect(start, 'функции contains_expected нет в deploy.yml').toBeGreaterThan(-1);
  const rest = DEPLOY.slice(start);
  const end = rest.indexOf('\n          }');
  expect(end, 'не найден конец функции').toBeGreaterThan(-1);
  // Внутри YAML тело с отступом блока `run: |` — снимаем его.
  return rest.slice(0, end + '\n          }'.length)
    .split('\n')
    .map(l => l.replace(/^ {10}/, ''))
    .join('\n');
}

let repo: string;
let base: string;      // предок: старый контейнер
let target: string;    // наш коммит
let descendant: string; // потомок: обгон более новым коммитом
let foreign: string;   // коммит из другой линии — наш в предках не значится

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commit(msg: string): string {
  writeFileSync(join(repo, 'f.txt'), `${msg}\n`);
  git(['add', 'f.txt']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

/** Запускает функцию из workflow. true — «прод содержит наш коммит». */
function containsExpected(candidate: string, expected = target): boolean {
  const script = `set -e\nEXPECTED_SHA=${expected}\n${extractFn()}\ncontains_expected "${candidate}"`;
  try {
    execFileSync('bash', ['-c', script], { cwd: repo, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'deploy-ancestry-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);

  base = commit('base');
  target = commit('target');
  descendant = commit('descendant');

  // Отдельная линия от base: наш коммит в неё не входит.
  git(['checkout', '-q', '-b', 'other', base]);
  foreign = commit('foreign');
  git(['checkout', '-q', 'main']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('contains_expected — поведение, а не текст', () => {
  it('ровно наш коммит — успех', () => {
    expect(containsExpected(target)).toBe(true);
  });

  it('потомок — успех: обгон более новым коммитом это публикация', () => {
    // Реальный сценарий 16.08: собран авто-коммит README поверх мержа.
    expect(containsExpected(descendant)).toBe(true);
  });

  it('предок — провал: прод остался на старом контейнере', () => {
    // Здесь строгость обязана сохраниться, иначе проверка перестаёт значить
    // что-либо: откат и застрявшая сборка выглядят именно так.
    expect(containsExpected(base)).toBe(false);
  });

  it('чужая линия — провал: нашего коммита в ней нет', () => {
    expect(containsExpected(foreign)).toBe(false);
  });

  it('пустой ответ панели — провал, а не «сойдёт»', () => {
    // curl вернул пустоту или JSON без commit: это незнание, не успех.
    expect(containsExpected('')).toBe(false);
  });

  it('несуществующий SHA — провал без падения проверки', () => {
    expect(containsExpected('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  it('короткий SHA потомка тоже принимается', () => {
    // Панель Timeweb и /version.json могут отдать сокращённую форму.
    expect(containsExpected(descendant.slice(0, 12))).toBe(true);
  });
});
