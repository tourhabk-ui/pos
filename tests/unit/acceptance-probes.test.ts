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

describe('probe-url: секрет уходит только своим крон-роутам', () => {
  /**
   * 23.08: workflow отрефакторили — GET и POST теперь ходят через ОДНУ
   * функцию `do_request` с одним `case` по адресу. Прежние проверки искали
   * `case` внутри отдельного POST-блока и требовали, чтобы адрес крон-роутов
   * встречался дважды; после сведения в одно место они покраснели, хотя
   * защита не ослабла, а усилилась: одно правило вместо двух не может
   * разъехаться.
   *
   * Поэтому здесь проверяется СВОЙСТВО, а не расположение строк.
   */
  const request = WF.slice(WF.indexOf('do_request() {'), WF.indexOf('# Ожидание выката'));

  it('решение об авторизации принимается по адресу, в одном месте', () => {
    expect(request).toMatch(/case "\$url" in/);
    expect(request).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
    // Ровно одна ветка выдаёт секрет: две разъезжаются, как разъехались
    // GET и POST до сведения.
    expect((request.match(/Authorization: Bearer/g) ?? []).length).toBe(1);
  });

  it('и GET, и POST проходят через ту же функцию — правило одно на оба', () => {
    expect(request).toMatch(/if \[ "\$method" = POST \]/);
    expect(request.slice(request.indexOf('if [ "$method" = POST ]')))
      .not.toMatch(/Authorization: Bearer/);
  });

  it('домен целиком больше не адресат секрета', () => {
    // Публичные роуты нашего же домена от чужого Bearer получали 401 от
    // Edge-middleware — проба публичного JSON была невозможна (09.08).
    expect(WF).not.toMatch(/https:\/\/vedarai\.ru\/\*\)/);
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
