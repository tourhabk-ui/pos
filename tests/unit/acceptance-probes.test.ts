/**
 * Инструменты приёмки перф-цепочки (владелец 08.08: список приёмки после
 * мержа — get_tours без блоба, EXPLAIN занятости на индексе, живые URL).
 *
 * Из песочницы прод недоступен; «глаза» — probe-url. Для приёмки добавлены:
 *   - POST-пробы в workflow (tools/call MCP GET-ом не проверить);
 *   - EXPLAIN-эндпоинт занятости под CRON_SECRET (боевой SQL, не похожий).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = readFileSync(join(ROOT, '.github/workflows/probe-url.yml'), 'utf-8');
const EXPLAIN = readFileSync(join(ROOT, 'app/api/cron/explain-availability/route.ts'), 'utf-8');
const PLANNER = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf-8');

describe('probe-url: POST-пробы', () => {
  /**
   * Сторож судит СВОЙСТВО, а не написание.
   *
   * Прежде здесь требовалось РОВНО ДВА блока `case "$PURL" in` — по одному на
   * GET и POST. Когда 22.08 обе одинаковые ветки схлопнулись в общую функцию
   * запроса, свойство стало СТРОЖЕ (решение о секрете принимается в одном
   * месте на оба метода), а сторож покраснел — он считал копии, а не смысл.
   *
   * Проверяемое свойство: каждое появление заголовка с секретом стоит внутри
   * ветки, отобранной по адресу `https://vedarai.ru/api/cron/*`. Сколько таких
   * веток — одна или пять — правилу безразлично.
   */
  it('секрет уходит ТОЛЬКО своим крон-роутам — на всяком пути, GET и POST', () => {
    const lines = WF.split('\n');
    const bearer = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /Authorization: Bearer/.test(l));

    expect(bearer.length, 'заголовок с секретом исчез из пробы — секрет никуда не уходит?').toBeGreaterThan(0);

    for (const { l, i } of bearer) {
      // Отбор по адресу стоит либо на самой строке (`case`-arm с командой в
      // одну строку), либо чуть выше — берём окно, включающее саму строку.
      const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      expect(
        window,
        `строка ${i + 1} шлёт CRON_SECRET, но выше нет отбора по адресу крон-роутов: ${l.trim()}`,
      ).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
    }
  });

  it('адрес секрета сузился до крон-роутов: домен целиком больше не адресат', () => {
    // Публичные роуты нашего же домена от чужого Bearer получали 401 от
    // Edge-middleware — проба публичного JSON была невозможна (09.08). Заодно
    // это строго уже прежнего правила: мест, куда уходит секрет, стало меньше.
    expect(WF).not.toMatch(/https:\/\/vedarai\.ru\/\*\)/);
    expect(WF).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
  });

  it('POST ждёт выката тем же правилом, что GET — петля ожидания одна на всех', () => {
    // Проба 99 сняла 404 у ещё не собравшегося роута и отчиталась успехом:
    // повтор и маркер свежести жили только в GET-ветке, POST бил один раз.
    // Две петли ожидания — это два правила, и одно из них снова отстанет.
    expect(WF.match(/while : ; do/g) ?? [], 'петля ожидания выката должна быть одна на оба метода').toHaveLength(1);
    expect(WF).toMatch(/ПРОБА НЕ УДАЛАСЬ/);
  });

  it('тело — из файла триггера, без shell-интерполяции JSON', () => {
    expect(WF).toMatch(/--data-binary @\/tmp\/postbody\.json/);
  });
});

describe('explain-availability: приёмка индексов 843', () => {
  it('под секретом и read-only: только EXPLAIN SELECT, никаких мутаций', () => {
    expect(EXPLAIN).toMatch(/verifyCronSecret/);
    expect(EXPLAIN).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(EXPLAIN).not.toMatch(/INSERT|UPDATE|DELETE|DROP|CREATE/);
  });

  it('меряется боевой запрос: LATERAL и фильтры дословно из планера', () => {
    for (const frag of [
      'CROSS JOIN LATERAL',
      "booking_status NOT IN ('cancelled', 'rejected')",
      'ta.is_cancelled = FALSE',
    ]) {
      expect(EXPLAIN).toContain(frag);
      expect(PLANNER).toContain(frag);
    }
  });

  it('флаги приёмки называют индексы 843 поимённо', () => {
    expect(EXPLAIN).toContain('idx_tour_availability_tour_date');
    expect(EXPLAIN).toContain('idx_operator_bookings_tour_date_active');
    expect(EXPLAIN).toMatch(/has_seq_scan_on_bookings/);
  });

  it('вход валидируется: tour — только цифры, окно клампится', () => {
    expect(EXPLAIN).toMatch(/\^\\d\{1,10\}\$/);
    expect(EXPLAIN).toMatch(/Math\.min\(Math\.max\(daysRaw, 1\), 31\)/);
  });
});
