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
 */
const fs = require('fs');
const path = require('path');

/** Sha текущего коммита или null, если по файлам его не установить. */
function resolveHeadSha(gitDir = '.git') {
  const read = (p) => fs.readFileSync(path.join(gitDir, p), 'utf8').trim();
  const isSha = (v) => /^[0-9a-f]{40}$/.test(v);

  let head;
  try {
    head = read('HEAD');
  } catch {
    return null;                       // .git не попал в контекст сборки
  }
  if (isSha(head)) return head;        // detached — sha лежит прямо в HEAD

  if (!head.startsWith('ref: ')) return null;
  const ref = head.slice(5).trim();

  try {
    const target = read(ref);          // .git/refs/heads/<branch>
    if (isSha(target)) return target;
  } catch {
    // Ветка упакована — ищем в packed-refs.
  }

  try {
    for (const line of read('packed-refs').split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && isSha(sha)) return sha;
    }
  } catch {
    // packed-refs нет — значит установить нечем.
  }
  return null;
}

function main() {
  const sha = resolveHeadSha();
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync(
    'public/version.json',
    JSON.stringify({ commit: sha ?? 'unknown', built_at: new Date().toISOString() }),
  );
  // Видно в логе сборки: если снова 'unknown', причина ищется здесь, а не в
  // Timeweb и не в проверке деплоя.
  console.log(`[version] commit=${sha ?? 'unknown'}`);
}

module.exports = { resolveHeadSha };

if (require.main === module) main();
