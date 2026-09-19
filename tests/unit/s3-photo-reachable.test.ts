// @vitest-environment node
/**
 * У снимка в хранилище спрашивают не запись, а ДОСТУПНОСТЬ.
 *
 * ── Повод (19.09) ─────────────────────────────────────────────────────────
 *
 * Владелец прислал карточку Вилючинского с пустым героем. Разбор нашёл две
 * причины в коде (см. place-photo-never-blank), но осталась третья, которую
 * из репозитория не видно вовсе:
 *
 * Снимки переезжают в S3 (§4.1, ночной `cron-images-to-s3`). Переезд обнуляет
 * `image_data` и записывает `s3_url`. Карточка отдаёт на этот адрес РЕДИРЕКТ,
 * и дальше за картинкой идёт БРАУЗЕР ТУРИСТА — без наших ключей, как чужой.
 *
 * Заливка ставит объекту `ACL: 'public-read'` и один раз читает его обратно,
 * сверяя размер. Но это проверка МОМЕНТА ПЕРЕЕЗДА. Политика бакета, смена
 * настроек или чужая рука могут закрыть доступ позже — и тогда в базе
 * по-прежнему ссылка, байты уже обнулены, а на экране пусто.
 *
 * Прежние переписи этого не ловили по построению: `images-in-s3` читает базу
 * («что записано»), `db-size-census` считает мегабайты, `images-oversize`
 * взвешивает. Ни одна не спрашивала объект.
 *
 * ── Почему проверка живёт в существующей пробе ────────────────────────────
 *
 * Сегодня в этом репозитории трижды нашлись по пять-шесть копий одного
 * словаря. Заводить седьмую перепись снимков ради одного вопроса значило бы
 * повторить ровно ту болезнь: `images-in-s3` уже знает, какие строки
 * перевезены, и вопрос «открывается ли» — продолжение того же, а не новая
 * тема.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROBE = readFileSync(join(ROOT, 'app/api/cron/images-in-s3/route.ts'), 'utf-8');

/**
 * Код без комментариев — для ЗАПРЕТОВ.
 *
 * Шапка пробы дословно перечисляет, чего в ней нет («ни одного
 * UPDATE/INSERT/DELETE»), и запрет, прочитавший это как нарушение, требует
 * стереть собственное объяснение. Сегодня эта ловушка сработала четвёртый
 * раз (dev-tools-db, migration-id-type-domain, place-card-speaks-human — и
 * здесь), так что вырезание заведено сразу, а не после красного прогона.
 */
const PROBE_CODE = PROBE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const S3 = readFileSync(join(ROOT, 'lib/storage/s3.ts'), 'utf-8');

describe('проверка доступности есть и спрашивает объект', () => {
  it('проба ходит HEAD-запросом, а не гадает по базе', () => {
    expect(PROBE).toContain("method: 'HEAD'");
    expect(PROBE).toContain('checkReachable');
  });

  it('HEAD, а не GET: нужен код ответа, а не байты', () => {
    expect(PROBE).not.toMatch(/fetch\(r\.s3_url,\s*\{\s*method:\s*'GET'/);
  });

  it('идёт без наших ключей — так же, как браузер туриста', () => {
    const at = PROBE.indexOf('async function checkReachable');
    const body = PROBE.slice(at, PROBE.indexOf('\n}', at));
    expect(body).not.toMatch(/Authorization|S3_ACCESS_KEY|S3_SECRET_KEY|signed|presign/i);
  });
});

describe('исходы разделены, третий не выдаётся за первый', () => {
  const at = PROBE.indexOf('type Reach');
  const decl = PROBE.slice(at, PROBE.indexOf(';', at));

  it('пять разных исходов, а не флаг «ок / не ок»', () => {
    for (const outcome of ['open', 'denied', 'missing', 'http', 'foreign', 'unreachable']) {
      expect(decl, `исход ${outcome} должен быть назван отдельно`).toContain(outcome);
    }
  });

  it('сеть не дошла — это «не смог проверить», а не «объект закрыт»', () => {
    expect(PROBE).toMatch(/unreachable[\s\S]{0,200}?§4\.0|§4\.0[\s\S]{0,200}?unreachable/);
    expect(PROBE).toContain("outcome: 'unreachable'");
  });

  it('«всё открыто» не утверждается при нулевой выборке', () => {
    // `checked.length > 0 &&` — иначе ноль проверенных читался бы как успех.
    expect(PROBE).toContain('all_open: checked.length > 0 &&');
  });

  it('отказавшие названы поимённо, а не только посчитаны', () => {
    expect(PROBE).toContain('failures:');
    expect(PROBE).toContain("r.outcome !== 'open'");
  });
});

describe('проба не превращается в отправитель запросов куда попало', () => {
  it('ходит только по адресам нашего хранилища', () => {
    expect(PROBE).toContain('s3PublicBase()');
    expect(PROBE).toContain('r.s3_url.startsWith(base)');
  });

  it('чужой адрес не запрашивается, а попадает в ответ отдельным исходом', () => {
    const at = PROBE.indexOf('if (!r.s3_url.startsWith(base))');
    const branch = PROBE.slice(at, at + 200);
    expect(branch).toContain("'foreign'");
    expect(branch).not.toContain('fetch(');
  });

  it('база адресов собирается из настроек, а не берётся из базы данных', () => {
    expect(S3).toContain('export function s3PublicBase');
    expect(S3).toMatch(/return `\$\{S3_ENDPOINT\}\/\$\{S3_BUCKET\}`/);
  });
});

describe('проба остаётся читающей и ограниченной', () => {
  it('ни одного UPDATE/INSERT/DELETE', () => {
    expect(PROBE_CODE).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i);
  });

  it('выборка ограничена потолком и по умолчанию не проверяет ничего', () => {
    expect(PROBE).toContain('MAX_CHECK');
    expect(PROBE).toMatch(/Math\.min\(MAX_CHECK/);
    // Без `?check=` проба ведёт себя как раньше: лишней сети не создаёт.
    expect(PROBE).toContain('check > 0 ?');
  });

  it('выборка случайная — иначе о прочих снимках не узнать', () => {
    expect(PROBE).toContain('ORDER BY random()');
  });

  it('у запроса есть срок: зависший объект не держит пробу', () => {
    expect(PROBE).toContain('AbortController');
    expect(PROBE).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), \d+/);
  });
});
