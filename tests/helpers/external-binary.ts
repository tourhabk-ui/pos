/**
 * Внешняя программа (python3, jq) для сторожей, которые проверяют её вызовом.
 *
 * Аудит 15.10, находка W3-china (ревью CN-quick): сторож моста без python3
 * писал строку в лог и делал return. Тест зеленел, хотя ничего не проверил.
 * По §4.0 «не смог проверить» не равно «прошло», поэтому исходов три:
 *   run  — программа есть: проверка выполняется;
 *   skip — программы нет, и это не CI: тест пропущен, причина — в его имени
 *          (у it.skipIf нет поля причины, а в имени её видно в отчёте);
 *   fail — программы нет в CI: явный отказ теста. На раннере она обязана
 *          быть, и её пропажа — поломка окружения, а не «проверять нечего».
 */
import { execFileSync } from 'node:child_process';

export type BinaryGate = 'run' | 'skip' | 'fail';

/** CI так, как его объявляет GitHub Actions (CI=true); пусто, «false» и «0» — не CI. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CI ?? '').trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0';
}

/** Исход по двум фактам: есть ли программа и идёт ли прогон в CI. */
export function binaryGate(available: boolean, ci: boolean): BinaryGate {
  if (available) return 'run';
  return ci ? 'fail' : 'skip';
}

/** Программа запускается: `<cmd> --version` отработал без ошибки. */
export function hasBinary(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    // Не запустилась — ровно тот факт, который здесь и выясняется; исход
    // (пропуск или отказ) решает binaryGate, а не это место.
    return false;
  }
}

export interface ExternalBinary {
  cmd: string;
  gate: BinaryGate;
  /** Для it.skipIf: пропуск только вне CI и только без программы. */
  skip: boolean;
  /** Имя теста; при пропуске в нём названа причина. */
  title(name: string): string;
  /** Первой строкой теста: в CI без программы — отказ с названной причиной. */
  require(what: string): void;
}

export function externalBinary(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  available: boolean = hasBinary(cmd),
): ExternalBinary {
  const gate = binaryGate(available, isCi(env));
  return {
    cmd,
    gate,
    skip: gate === 'skip',
    title: (name) => (gate === 'skip' ? `${name} [пропуск вне CI: ${cmd} не найден — проверка не выполнена]` : name),
    require: (what) => {
      if (gate === 'fail') {
        throw new Error(`${cmd} не найден в CI: ${what} не проверить вызовом — «не смог» не равно «прошло» (§4.0)`);
      }
    },
  };
}
