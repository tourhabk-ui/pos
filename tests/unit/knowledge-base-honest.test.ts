/**
 * База знаний говорит, из чего собрана, и различает три отказа (#1783).
 *
 * ── Что нашлось ────────────────────────────────────────────────────────────
 *
 * `/api/ai/knowledge-base` собирал «базу знаний» из шести документов проекта.
 * Пяти из шести нет в репозитории; шестого (README.md) нет в ОБРАЗЕ, потому
 * что Dockerfile его туда не копирует. То есть на проде файловая ветка сбора
 * давала ноль документов по построению — и молчала об этом: `fs.existsSync`
 * пропускал путь без единого слова, а ответ звучал «База знаний обновлена»
 * одинаково при шести документах и при нуле.
 *
 * Отказов было семь, и все глухие. Главный: `updateKnowledgeBase` возвращала
 * `false` сразу за ТРИ разных состояния — «выгрузка выключена», «сервер
 * ответил отказом», «упало исключение», — а текст ответа Timeweb, который
 * единственный объяснил бы отказ, читался в переменную и выбрасывался.
 * Читающий получал «Failed to update knowledge base» и не мог понять, чинить
 * настройку, доступ или запрос (§4.0).
 *
 * ── Что держит этот сторож ─────────────────────────────────────────────────
 *
 * Не текст сообщений, а три свойства: отказ называется, состав источников
 * доходит до ответа, и обещание «этот документ попадёт в базу» не переживает
 * файл, которого нет в образе. Последнее — самоустаревающий реестр по образцу
 * `KNOWN_UNPRODUCED`: появился путь в образе — запись обязана уйти.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const ROUTE = read('app/api/ai/knowledge-base/route.ts');
/** Код без комментариев: дефект, ПРОЦИТИРОВАННЫЙ в пояснении, кодом не является. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const DOCKERFILE = read('Dockerfile');

/** Пути, которые маршрут обещает прочитать. */
function declaredDocPaths(): string[] {
  const block = /const docPaths = \[([\s\S]*?)\]/.exec(CODE);
  if (block === null) throw new Error('Список docPaths не найден');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Что реально попадает в runner-образ. Берётся из самого Dockerfile, а не из
 * памяти: список COPY менялся и будет меняться, а замороженная копия здесь
 * устарела бы молча — ровно та болезнь, от которой этот файл и заведён.
 */
function copiedIntoRunner(): string[] {
  const runner = DOCKERFILE.slice(DOCKERFILE.indexOf('AS runner'));
  return [...runner.matchAll(/^COPY\s+(?:--from=\S+\s+)?(\S+)/gm)]
    .map((m) => m[1].replace(/^\/app\//, ''))
    .filter((p) => p !== '.');
}

function isShipped(docPath: string): boolean {
  return copiedIntoRunner().some((c) => docPath === c || docPath.startsWith(`${c.replace(/\/$/, '')}/`));
}

/**
 * Пути, которых в образе НЕТ, с причиной. Реестр самоустаревающий: как только
 * путь начнут копировать в runner, тест потребует убрать отсюда запись.
 * Сокращаться может, расти — только вместе с осознанным решением.
 */
const KNOWN_NOT_IN_IMAGE: Record<string, string> = {
  'README.md': 'Dockerfile не копирует README в runner — на проде ветка даёт ноль документов',
  'docs/AI_ASSISTANTS_GUIDE.md': 'файла нет в репозитории с неизвестного момента',
  'docs/ROLES_IMPLEMENTATION_PLAN.md': 'файла нет в репозитории с неизвестного момента',
  'docs/DEPLOYMENT_READY.md': 'файла нет в репозитории с неизвестного момента',
  'ЧЕСТНАЯ_ПРОВЕРКА_ЗАГЛУШЕК.md': 'файла нет в репозитории с неизвестного момента',
  'ФИНАЛЬНЫЙ_ОТЧЁТ_ДОРАБОТКИ_ДО_100.md': 'файла нет в репозитории с неизвестного момента',
};

describe('состав базы знаний: обещание не переживает источник', () => {
  it('каждый обещанный документ либо едет в образ, либо записан с причиной', () => {
    const undocumented = declaredDocPaths().filter(
      (p) => !isShipped(p) && !(p in KNOWN_NOT_IN_IMAGE),
    );
    expect(
      undocumented,
      'путь обещан, в образ не едет и в реестре не назван — на проде он даст тишину',
    ).toEqual([]);
  });

  it('реестр самоустаревающий: доехавшее до образа из него убирается', () => {
    const nowShipped = Object.keys(KNOWN_NOT_IN_IMAGE).filter(isShipped);
    expect(
      nowShipped,
      'путь теперь копируется в runner — запись в KNOWN_NOT_IN_IMAGE устарела, убрать',
    ).toEqual([]);
  });

  it('реестр называет только то, что маршрут действительно обещает', () => {
    const declared = new Set(declaredDocPaths());
    const stale = Object.keys(KNOWN_NOT_IN_IMAGE).filter((p) => !declared.has(p));
    expect(stale, 'запись про путь, которого в docPaths больше нет').toEqual([]);
  });

  it('файл, которого нет, называется в ответе, а не пропускается молча', () => {
    // Прежде тут стоял `fs.existsSync`, и пропуск не оставлял следа нигде.
    expect(CODE, 'вернулась проверка существования вместо чтения с разбором отказа')
      .not.toMatch(/fs\.existsSync/);
    expect(CODE).toMatch(/status: code === 'ENOENT' \? 'missing' : 'failed'/);
  });
});

describe('отказ называется, а не глушится (§4.0)', () => {
  it('в коде маршрута нет пустых catch', () => {
    expect(CODE).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/);
  });

  it('в коде маршрута нет пустых блоков-заглушек', () => {
    // `if (documents.length > maxDocs) {}` — обрезка происходила молча.
    expect(CODE).not.toMatch(/if\s*\([^)]*\)\s*\{\s*\}/);
  });

  it('у выгрузки четыре исхода, а не булево', () => {
    for (const outcome of ["'ok'", "'disabled'", "'http_error'", "'exception'"]) {
      expect(ROUTE, `исход ${outcome} пропал из KbUpdateResult`).toContain(outcome);
    }
    expect(CODE, 'вернулась булева выгрузка — три отказа снова схлопнутся в один')
      .not.toMatch(/updateKnowledgeBase\([^)]*\): Promise<boolean>/);
  });

  it('ответ Timeweb доходит до читающего, а не выбрасывается', () => {
    // Раньше: `const errorText = await response.text()` и сразу `return false`.
    expect(CODE).toMatch(/status: 'http_error'/);
    expect(CODE).toMatch(/body,/);
  });

  it('три отказа дают три разных ответа, а не одну фразу', () => {
    expect(CODE).toMatch(/status: 409/);   // не настроено
    expect(CODE).toMatch(/status: 502/);   // сервер отверг или не дошли
    expect(CODE, 'вернулась общая фраза на все отказы')
      .not.toContain("error: 'Failed to update knowledge base'");
  });

  it('туры и операторы разбираются по отдельности', () => {
    // Один общий catch писал «операторы не попали», даже когда падал запрос
    // туров: сообщение называло не того виноватого, а второй запрос при этом
    // не выполнялся вовсе.
    expect(CODE).toMatch(/source: 'operator_tours', kind: 'db', status: 'failed'/);
    expect(CODE).toMatch(/source: 'partners', kind: 'db', status: 'failed'/);
  });
});

describe('статус говорит, о чём он', () => {
  it('GET оговаривает, что его счётчик — про локальную таблицу, а не про выгрузку', () => {
    // documentCount читается из knowledge_base_articles, куда POST не пишет.
    expect(ROUTE).toMatch(/knowledge_base_articles/);
    expect(CODE).toMatch(/note:/);
  });

  it('POST отдаёт состав источников даже при успехе', () => {
    // «Собрано 3 документа» не говорит, что пять других не нашлись.
    expect(CODE).toMatch(/sources,/);
    expect(CODE).toMatch(/missingSources/);
    expect(CODE).toMatch(/НЕ ПОЛНОСТЬЮ/);
  });
});

describe('разбор расхождений со скриптом-соседом записан, а не угадан', () => {
  it('докстрока называет все три расхождения с sync-timeweb-kb', () => {
    // Адрес, форма тела и имя переменной токена — три независимых признака
    // того, что эта выгрузка, скорее всего, не работала ни разу. Чинить по
    // догадке нельзя: контракт Timeweb отсюда не проверяется.
    expect(ROUTE).toMatch(/sync-timeweb-kb/);
    expect(ROUTE).toMatch(/TIMEWEB_TOKEN/);
    expect(ROUTE).toMatch(/TIMEWEB_API_TOKEN/);
    expect(ROUTE).toMatch(/\/documents/);
  });

  it('скрипт-сосед на месте — иначе разбор выше говорит о несуществующем', () => {
    expect(existsSync(join(ROOT, 'scripts/sync-timeweb-kb.ts'))).toBe(true);
  });
});
