// @vitest-environment node
/**
 * /api/cron/emsd-vmon-probe — обещание «только читает», и прогон, который не
 * выдаёт отказ за успех.
 *
 * Проба существует, чтобы сказать, что мы УВИДИМ в сводке КФ ФИЦ ЕГС РАН,
 * прежде чем кто-нибудь начнёт на основании этого писать статусы вулканов или
 * поднимать тревоги. Появись здесь write-путь — она перестанет быть переписью
 * и станет вторым, негласным писателем в поле, которое уже пишет KVERT.
 *
 * Про «не выдаёт отказ за успех» тут не теория: 20.09 сверка с OSM вернула
 * `{"success": false}`, а job остался ЗЕЛЁНЫМ, и по пустому списку я чуть не
 * вынес вывод «расхождений нет». У вулканов цена той же ошибки выше: пустота
 * прочиталась бы как «вулканы спокойны».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/emsd-vmon-probe/route.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/emsd-vmon-probe.yml'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('проба только читает', () => {
  it('экспортирует только GET', () => {
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('ни одного write-запроса', () => {
    expect(code).not.toMatch(/UPDATE\s|INSERT INTO|DELETE FROM/);
  });

  it('в volcano_status только SELECT', () => {
    // Второй писатель в поле, которое ведёт KVERT, — это два источника
    // истины про цвет одного вулкана (§12).
    const at = code.indexOf('volcano_status');
    expect(at, 'запроса к volcano_status нет вовсе').toBeGreaterThan(0);
    expect(code.slice(Math.max(0, at - 300), at)).toMatch(/SELECT/);
  });

  it('авторизация — Bearer CRON_SECRET постоянным временем, и 401 объясняет себя', () => {
    expect(code).toContain('getCronSecret');
    expect(code).toContain('timingSafeCompare');
    expect(code).toContain('diagnoseCronAuth');
  });

  it('маркер версии есть — по нему видно, та ли сборка отвечает', () => {
    expect(SRC).toMatch(/emsd_vmon_probe_v\d+/);
  });
});

describe('кодировка названа, а не подразумевается', () => {
  it('байты берутся сырыми, а не через res.text()', () => {
    // res.text() разобрал бы windows-1251 как UTF-8 и отдал кракозябры,
    // которые парсер примет за «вулканов ноль».
    expect(code).toContain('arrayBuffer()');
    expect(code, 'res.text() вернул бы кракозябры на cp1251').not.toMatch(/res\.text\(\)/);
  });

  it('отказ декодера называется словами, а не глушится', () => {
    // TextDecoder('windows-1251') требует полного ICU, а рантайм —
    // node:22-alpine. Нет декодера — это «не смог», и оно обязано звучать.
    expect(code).toContain('TextDecoder');
    expect(code).toMatch(/декодер/);
    expect(code).toContain('console.error');
  });

  it('чем разобрали — в ответе', () => {
    expect(code).toMatch(/decoded_by/);
  });
});

describe('расхождение с KVERT сообщается фактом, а не вердиктом', () => {
  it('в ответе есть счёт расхождений', () => {
    expect(code).toMatch(/disagreements_total/);
  });

  it('проба не решает, чей цвет вернее', () => {
    // Тот же принцип, что у clusterConflicts в подсказчике связей: улика без
    // приговора. Автомат, выбирающий победителя, испортил бы данные молча.
    expect(code, 'проба назначает победителя — это решение владельца')
      .not.toMatch(/emsd_wins|kvert_wins|preferSource|authoritative/i);
  });

  it('отказ БД отделён от «расхождений нет»', () => {
    expect(code).toMatch(/kvert_compare_error/);
    expect(code).toMatch(/ours\.rows === null \? null/);
  });
});

describe('прогон не выдаёт отказ за успех', () => {
  it('вердикт по success, а не по тому, что json разобрался', () => {
    expect(WF).toContain("d.get('success') is not True");
    const at = WF.indexOf("d.get('success') is not True");
    expect(WF.slice(at, at + 500)).toContain('sys.exit(1)');
  });

  it('пустой ответ — «не смогли спросить», а не «сводка пуста»', () => {
    expect(WF).toMatch(/if \[ -z "\$RESP" \]; then/);
    expect(WF).toContain('не ответила вовсе');
  });

  it('ноль разобранных вулканов — тоже отказ', () => {
    // Живая страница с нулём вулканов значит смену вёрстки или неверную
    // кодировку. Промолчать об этом значило бы прочитать «вулканы спокойны».
    expect(WF).toContain("if not d.get('volcanoes_total')");
    const at = WF.indexOf("if not d.get('volcanoes_total')");
    expect(WF.slice(at, at + 400)).toContain('sys.exit(1)');
  });

  it('причина отказа печатается целиком, а не выбрасывается', () => {
    expect(WF).toContain('Тело ответа целиком');
  });

  it('ждёт свою сборку, раз запускается маркером', () => {
    expect(WF).toContain('wait-for-deploy.sh');
    expect(WF).toMatch(/REQUIRE_FRESH: '1'/);
  });
});
