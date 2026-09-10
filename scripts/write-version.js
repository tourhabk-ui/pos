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
 *
 * 10.09.2026 (#1762): на проде маркер отвечает `no_git_head` — то есть `.git`
 * не доезжает до `COPY . .` ВОВСЕ, и обе прежние починки (разыменование
 * ссылки, форма `.git/*`) тут ни при чём: чинить нечего, файла нет. Цена
 * незнания перестала быть теоретической: без sha у проверки деплоя остаётся
 * один признак «это моя сборка» — `built_at`, а он ложный (образ предыдущего
 * коммита, собранный после нашего пуша, тоже новее пуша). Дважды за час
 * старый контейнер сошёл за свежий.
 *
 * Поэтому sha спрашивается СНАЧАЛА у окружения сборки и только потом у `.git`:
 * переменная не зависит от того, клон перед нами или распакованный архив.
 * Имена — явный список `SHA_ENV_NAMES`, а не «что-нибудь похожее на sha»:
 * угаданный источник ничем не лучше угаданного значения. `BUILD_COMMIT_SHA` —
 * наше имя (его можно задать в панели приложения), остальные — расхожие имена
 * провайдеров на случай, если Timeweb уже что-то передаёт.
 *
 * Внутрь сборки Docker передаёт только то, что объявлено `ARG`, — поэтому те
 * же имена объявлены в Dockerfile перед вызовом скрипта, а паритет списков
 * держит сторож. Какие из них реально ПРИШЛИ, видно в `env_probe` маркера:
 * пустой список — честный ответ «сборке не дали ничего», а не молчание.
 */
const fs = require('fs');
const path = require('path');

/**
 * Имена переменных окружения сборки, из которых берётся sha, — по порядку
 * доверия. Первое наше (задаётся в панели/build-arg), дальше расхожие имена
 * провайдеров. Список ЗАКРЫТ намеренно: брать «любую переменную, похожую на
 * sha», значит однажды записать в маркер чужой ключ из 40 hex.
 *
 * Источник правды для Dockerfile (ARG) и для рантайм-пробы
 * (lib/build/commit-sha.ts). Дубли держит сторож build-sha-source.
 */
const SHA_ENV_NAMES = [
  'BUILD_COMMIT_SHA', // наше имя: панель Timeweb / --build-arg
  'SOURCE_COMMIT',    // Docker Hub autobuild и ряд PaaS
  'GIT_COMMIT',
  'COMMIT_SHA',
  'GIT_SHA',
  'VCS_REF',          // соглашение OCI-меток
  'CI_COMMIT_SHA',    // GitLab CI
  'GITHUB_SHA',       // сборка на раннере GitHub
];

/** 7–40 hex: короткий sha провайдера — тоже ответ, а не «не знаю». */
const SHA_SHAPE = /^[0-9a-f]{7,40}$/;

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

/**
 * Sha сборки: сперва окружение (переменная переживает и архив без `.git`),
 * потом файлы `.git`. Возвращает ещё и то, ОТКУДА взято и что было видно, —
 * иначе «unknown» второй месяц подряд нечем разбирать.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [gitDir]
 * @returns {{
 *   sha: string|null, reason: string, source: string|null,
 *   envProbe: string[], envMalformed: string[]
 * }} source: 'env:<ИМЯ>' | 'git' | null. reason='ok' при успехе.
 */
function resolveBuildSha(env = process.env, gitDir = '.git') {
  // Что вообще ДОШЛО до сборки под известными именами. Пустой список —
  // содержательный ответ: переменных не передают, и просить надо панель.
  const envProbe = SHA_ENV_NAMES.filter((n) => String(env[n] ?? '').trim() !== '');
  /** Имя задано, а значение на sha не похоже: это не «нет», это «задано неверно». */
  const envMalformed = [];

  for (const name of SHA_ENV_NAMES) {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    if (!raw) continue;
    if (SHA_SHAPE.test(raw)) {
      return { sha: raw, reason: 'ok', source: `env:${name}`, envProbe, envMalformed };
    }
    // Молчать нельзя (§4.0): имя уедет в маркер и в лог сборки, значение — нет.
    envMalformed.push(name);
  }

  const git = resolveHeadShaDetailed(gitDir);
  if (git.sha) return { sha: git.sha, reason: 'ok', source: 'git', envProbe, envMalformed };
  return { sha: null, reason: git.reason, source: null, envProbe, envMalformed };
}

function main() {
  const { sha, reason, source, envProbe, envMalformed } = resolveBuildSha();
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync(
    'public/version.json',
    JSON.stringify({
      commit: sha ?? 'unknown',
      built_at: new Date().toISOString(),
      // Почему 'unknown'. При успехе — 'ok': поле есть всегда, чтобы его
      // отсутствие означало «маркер старой сборки», а не «причина не нужна».
      reason,
      // Откуда взят sha. Разные источники ломаются по-разному: 'env:...'
      // переживает архив без .git, 'git' — правки переменных в панели.
      source,
      // Диагностика печатается ТОЛЬКО когда sha нет: при удаче она шум, а
      // маркер лежит на публичном адресе. Имена наши и заранее известные,
      // значений здесь нет и быть не может.
      ...(sha ? {} : { env_probe: envProbe, env_malformed: envMalformed }),
    }),
  );
  // Видно в логе сборки: если снова 'unknown', здесь стоит КЛАСС причины,
  // а не одно слово на три разных беды.
  console.log(`[version] commit=${sha ?? 'unknown'} reason=${reason}`);
  console.log(
    `[version] source=${source ?? '-'} env_probe=${envProbe.join(',') || '-'}` +
      (envMalformed.length ? ` env_malformed=${envMalformed.join(',')}` : ''),
  );
}

module.exports = { resolveHeadSha, resolveHeadShaDetailed, resolveBuildSha, SHA_ENV_NAMES };

if (require.main === module) main();
