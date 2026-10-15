// @vitest-environment node
/**
 * Сторож: всё, что попадает в образ прода, доезжает до прода (18.09; обобщён
 * аудитом 15.10, находка AR-deploy).
 *
 * ── Что случилось 18.09 ───────────────────────────────────────────────────
 *
 * Владелец прислал три своих снимка маяка; миграция 977 положила их на
 * карточку. Коммит содержал РОВНО ОДИН файл — `.sql`. CI не запустился:
 * в `ci.yml` список `paths` перечислял только код. Выкат идёт по завершении
 * CI (`deploy.yml`, `workflow_run`), значит не было и его, а миграции
 * накатывает `start.js` при старте контейнера — то есть только на выкате.
 * Итог: миграция лежала в `main` и на прод не попадала НИКОГДА, и ни одна
 * проверка не покраснела — проверять было нечего.
 *
 * ── Почему обобщён 15.10 ──────────────────────────────────────────────────
 *
 * Починка 18.09 закрыла один путь из многих: в список внесли `migrations/**`,
 * а `app/globals.css` (токены DS), `public/**`, Dockerfile, .dockerignore,
 * данные `*.json` так и остались вне его. `COPY . .` в Dockerfile кладёт в
 * образ ВСЁ, кроме .dockerignore. Пока Timeweb выкатывал каждый пуш вебхуком,
 * дыра пряталась; с выключенным автодеплоем (CLAUDE.md §6) выкатывается
 * только то, что прошло CI, и путь вне фильтра не доехал бы никогда.
 *
 * ── Что держит сторож (поведение, не текст) ───────────────────────────────
 *
 * Перебирается КАЖДЫЙ файл репозитория, который Docker видит в контексте
 * сборки (git ls-files минус .dockerignore по правилам Docker), и для него
 * спрашивается фильтр push-события CI по правилам GitHub: запустит ли его
 * изменение прогон на main. Плюс сами Dockerfile и .dockerignore — их нет в
 * контексте, но они и есть образ. Уберут фильтр — зелёно; вернут лоскутный
 * список — красно, с именами файлов, которые не доехали бы. И связка: выкат
 * по-прежнему ждёт CI, иначе фильтр ни при чём (правило 10.09).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadWorkflow,
  githubTriggersOn,
  dockerIgnored,
  dockerignorePatterns,
  type PathFilter,
} from '../helpers/workflow-semantics';

const ROOT = process.cwd();
const ci = loadWorkflow('.github/workflows/ci.yml');
const deploy = loadWorkflow('.github/workflows/deploy.yml');
const pushFilter = ci.on['push'] as PathFilter | null | undefined;
const prFilter = ci.on['pull_request'] as PathFilter | null | undefined;

const IGNORE = dockerignorePatterns(readFileSync(join(ROOT, '.dockerignore'), 'utf-8'));
const TRACKED = execFileSync('git', ['-c', 'color.ui=false', 'ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
const IN_IMAGE = TRACKED.filter((f) => !dockerIgnored(f, IGNORE));

describe('правила, по которым судит сторож, сами верны', () => {
  // Без этого блока сторож мог бы зеленеть на сломанном разборе: «всё
  // запускает CI», потому что разбор фильтра всегда отвечает «да».
  it('лоскутный список 18.09 css и public не запускал — разбор это видит', () => {
    const old: PathFilter = {
      paths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.mts', 'package*.json',
        'tsconfig*.json', 'next.config.*', 'migrations/**', '.github/workflows/ci.yml'],
    };
    expect(githubTriggersOn(old, 'migrations/0977_x.sql')).toBe(true);
    expect(githubTriggersOn(old, 'lib/a.ts')).toBe(true);
    expect(githubTriggersOn(old, 'a.ts'), '`**/` — и корень тоже').toBe(true);
    expect(githubTriggersOn(old, 'app/globals.css')).toBe(false);
    expect(githubTriggersOn(old, 'public/images/x.jpg')).toBe(false);
    expect(githubTriggersOn(old, 'Dockerfile')).toBe(false);
  });

  it('`!` в paths отменяет совпадение, решает последнее правило', () => {
    const f: PathFilter = { paths: ['**', '!**/*.md', 'DEPLOY_NOW.md'] };
    expect(githubTriggersOn(f, 'docs/a.md')).toBe(false);
    expect(githubTriggersOn(f, 'DEPLOY_NOW.md')).toBe(true);
    expect(githubTriggersOn(f, 'app/page.tsx')).toBe(true);
  });

  it('.dockerignore по правилам Docker: каталог целиком, `*.md` — только корень', () => {
    expect(dockerIgnored('node_modules/x/y.js', ['node_modules'])).toBe(true);
    expect(dockerIgnored('README.md', ['*.md'])).toBe(true);
    expect(dockerIgnored('docs/A.md', ['*.md']), '`*` не пересекает `/`').toBe(false);
    expect(dockerIgnored('DEPLOY_NOW.md', ['*.md', '!DEPLOY_NOW.md'])).toBe(false);
    expect(dockerIgnored('media/s3/a.jpg', ['media/'])).toBe(true);
  });

  it('в контексте сборки есть и код, и css, и public — перебирать есть что', () => {
    expect(IN_IMAGE).toContain('app/globals.css');
    expect(IN_IMAGE).toContain('package.json');
    expect(IN_IMAGE.some((f) => f.startsWith('migrations/'))).toBe(true);
    expect(IN_IMAGE.some((f) => f.startsWith('public/'))).toBe(true);
    expect(IN_IMAGE).not.toContain('README.md');
  });
});

describe('всё, что попадает в образ, запускает CI на main', () => {
  it('push слушает ветку main', () => {
    expect(pushFilter?.branches ?? []).toContain('main');
  });

  it('каждый файл контекста сборки запускает CI при пуше в main', () => {
    const missed = IN_IMAGE.filter((f) => !githubTriggersOn(pushFilter, f));
    expect(
      missed.slice(0, 20),
      `не запускают CI (и при выключенном автодеплое не доехали бы до прода): ${missed.length}`,
    ).toEqual([]);
  });

  it('Dockerfile и .dockerignore — тоже: они и есть образ', () => {
    expect(githubTriggersOn(pushFilter, 'Dockerfile')).toBe(true);
    expect(githubTriggersOn(pushFilter, '.dockerignore')).toBe(true);
  });

  it('миграция в PR по-прежнему проверяется до ревью', () => {
    // Иначе миграция проходит ревью непроверенной: тот же разрыв 18.09,
    // только раньше по течению.
    expect(githubTriggersOn(prFilter, 'migrations/0977_lighthouse_photos.sql')).toBe(true);
  });

  it('выкат по-прежнему привязан к завершению CI — иначе фильтр ни при чём', () => {
    // Этот факт и делает фильтр решающим: он превращает «что проверяем» в
    // «что доедет». Развяжут — сторож обязан краснеть и быть переписан.
    const wr = deploy.on['workflow_run'] as { workflows?: string[] } | undefined;
    expect(wr?.workflows).toContain('CI');
  });
});
