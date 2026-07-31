/**
 * #883: POST-наблюдатель не дублирует heartbeat и не врёт про здоровье.
 *
 * Разбор issue показал: ингест бежит из двух планировщиков (heartbeat-GET
 * каждые 5 минут из start.js и POST из GitHub Actions ~раз в час), POST
 * тянул VK/USGS/МЧС RSS вторым и отдавал «inserted: 0», читавшееся как
 * «канал МЧС молчит». Ловушка починки, названная в issue: убрать источники
 * из POST и записать для них not_fetched = объявить живой канал мёртвым.
 *
 * Контракт после фикса:
 *   · POST не тянет делегированные источники (VK API с лимитами — дважды
 *     в цикл не ходим);
 *   · POST НЕ пишет их ключи в health вовсе (ни ok, ни not_fetched) —
 *     строку каждые 5 минут обновляет heartbeat, ложный КРИТ невозможен
 *     по построению; смерть самого heartbeat ловит checkSeismicCronDead;
 *   · ответ POST вместо вводящих в заблуждение нулей отдаёт явный список
 *     delegated_to_heartbeat;
 *   · GET-heartbeat продолжает обслуживать все источники (ingestAll).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const postBlock = code.slice(code.indexOf('export async function POST'));
const getBlock = code.slice(code.indexOf('export async function GET'), code.indexOf('const HtmlBodySchema'));

describe('POST не дублирует heartbeat (#883 B)', () => {
  it('делегированные ингесты из POST ушли', () => {
    for (const fn of ['ingestVkMchs(', 'ingestMchsAlerts(', 'ingestUsgs(', 'ingestFirmsWildfires(']) {
      expect(postBlock, `${fn} вернулся в POST — двойная работа и лимиты VK`).not.toContain(fn);
    }
  });

  it('GET-heartbeat покрывает всё: ingestAll + FIRMS на месте', () => {
    expect(getBlock).toContain('ingestAll()');
    expect(getBlock).toContain('ingestFirmsWildfires()');
  });

  it('транспортная роль POST сохранена: t.me/kamgov/minec/MAX', () => {
    expect(postBlock).toContain('ingestFromHtml(');
    expect(postBlock).toContain('ingestNewsFeedXmls(');
    expect(postBlock).toContain('ingestMaxItems(');
  });
});

describe('здоровье источников не врёт (#883, ловушка из issue)', () => {
  it('POST не пишет делегированные ключи в health — ни ok, ни not_fetched', () => {
    const healthBlock = postBlock.slice(postBlock.indexOf('watchSourceHealth'), postBlock.indexOf('buildResponse'));
    for (const key of ["'vk_mchs'", "'mchs_rss'", "'firms'"]) {
      expect(healthBlock, `${key} в health POST — при недоступном результате это not_fetched и ложный КРИТ`)
        .not.toContain(key);
    }
    // Уникальные для POST источники остаются под наблюдением.
    expect(healthBlock).toContain("'kbgsras'");
    expect(healthBlock).toContain("'max_mchs'");
  });

  it('GET продолжает писать health делегированных — там результат настоящий', () => {
    for (const key of ["'vk_mchs'", "'mchs_rss'", "'firms'"]) {
      expect(getBlock).toContain(key);
    }
  });
});

describe('ответ POST честен (#883 A)', () => {
  it('вместо нулей — явный список delegated_to_heartbeat', () => {
    expect(postBlock).toContain('delegated_to_heartbeat');
    expect(postBlock).toMatch(/'mchs_rss', 'usgs', 'vk_mchs', 'firms'/);
  });
});
