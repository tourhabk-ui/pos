/**
 * scripts/write-version.js — маркер деплоя public/version.json.
 *
 * Пишет, какой коммит собран и когда. По этому файлу шаг «Verify deploy
 * reached production» отличает «контейнер переключился» от «Timeweb собрал, но
 * отдаёт прежнюю ревизию» — иначе выкладка доказывается таймером, а таймер
 * ничего не доказывает.
 *
 * 23.08.2026: маркер отдавал `unknown`, и проверка падала на КАЖДОМ деплое.
 * Прежний код читал `.git/HEAD` и требовал там голые 40 hex — в расчёте на
 * detached-сборку. Сборка идёт с веткой: в HEAD лежит `ref: refs/heads/main`,
 * а файла, на который он указывает, в образе не было (`.dockerignore` пускал
 * только сам HEAD). Итог: сайт не мог назвать свой коммит, и «доехало ли»
 * было неизвестно ВСЕГДА — то есть отказ проверки не значил ничего.
 *
 * Здесь ссылка разыменовывается: HEAD → refs/heads/… → packed-refs. Без
 * git-бинаря и без сети: на этапе сборки ни того, ни другого может не быть.
 *
 * `unknown` остаётся законным исходом — например, при локальной сборке без
 * `.git`. Это честное «не знаю», и проверка деплоя обязана трактовать его как
 * «не смог подтвердить», а не как «не доехало».
 *
 * 30.08.2026: `unknown` вернулся ТРЕТИЙ раз — после починки 23.08 (разыменование
 * ссылки) и 29.08 (форма `.git/*` в .dockerignore). Обе прежние причины закрыты
 * и держатся сторожами, значит причина новая, и назвать её было нечем: на три
 * независимых исхода приходилось одно слово. Аудит 30.08 замерил цену: 238
 * красных прогонов деплоя подряд с 20.08.
 *
 * Отсюда `reason` — короткий машинный код, ПОЧЕМУ не установлено. Он уходит
 * и в лог сборки, и в сам `version.json`: тогда проверка деплоя называет
 * причину прямо в прогоне, не заставляя лезть в сборочный лог Timeweb.
 * Разница между «`.git` не доехал вовсе» и «доехал без ссылок» — это разные
 * починки, и раньше их нельзя было отличить.
 */
const fs = require('fs');
const path = require('path');

/**
 * Sha текущего коммита ВМЕСТЕ с причиной, если установить не удалось.
 * @returns {{ sha: string|null, reason: string }} reason='ok' при успехе.
 */
function resolveHeadShaDetailed(gitDir = '.git') {
  const read = (p) => fs.readFileSync(path.join(gitDir, p), 'utf8').trim();
  const isSha = (v) => /^[0-9a-f]{40}$/.test(v);

  let head;
  try {
    head = read('HEAD');
  } catch {
    // .git не попал в контекст сборки вовсе — чинится контекстом/.dockerignore.
    return { sha: null, reason: 'no_git_head' };
  }
  if (isSha(head)) return { sha: head, reason: 'ok' };   // detached — sha прямо в HEAD

  if (!head.startsWith('ref: ')) return { sha: null, reason: 'head_unrecognized' };
  const ref = head.slice(5).trim();

  let refFileRead = false;
  try {
    const target = read(ref);          // .git/refs/heads/<branch>
    refFileRead = true;
    if (isSha(target)) return { sha: target, reason: 'ok' };
  } catch {
    // Ветка упакована либо файла ссылки нет — ищем в packed-refs.
  }

  let packed;
  try {
    packed = read('packed-refs');
  } catch {
    // Ни файла ссылки, ни packed-refs: ссылки в образ не попали.
    return { sha: null, reason: refFileRead ? 'ref_malformed' : 'ref_and_packed_missing' };
  }

  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && isSha(sha)) return { sha, reason: 'ok' };
  }
  // packed-refs прочитан, но нашей ветки в нём нет — это уже про состояние
  // клона, а не про контекст сборки.
  return { sha: null, reason: refFileRead ? 'ref_malformed' : 'ref_not_in_packed' };
}

/**
 * Совместимая обёртка: sha или null. Оставлена ради вызывающих, которым
 * причина не нужна, — новый код зовёт resolveHeadShaDetailed.
 */
function resolveHeadSha(gitDir = '.git') {
  return resolveHeadShaDetailed(gitDir).sha;
}

function main() {
  const { sha, reason } = resolveHeadShaDetailed();
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync(
    'public/version.json',
    JSON.stringify({
      commit: sha ?? 'unknown',
      built_at: new Date().toISOString(),
      // Почему 'unknown'. При успехе — 'ok': поле есть всегда, чтобы его
      // отсутствие означало «маркер старой сборки», а не «причина не нужна».
      reason,
    }),
  );
  // Видно в логе сборки: если снова 'unknown', здесь стоит КЛАСС причины,
  // а не одно слово на три разных беды.
  console.log(`[version] commit=${sha ?? 'unknown'} reason=${reason}`);
}

module.exports = { resolveHeadSha, resolveHeadShaDetailed };

if (require.main === module) main();
