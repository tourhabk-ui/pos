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
  it('секрет уходит ТОЛЬКО своим крон-роутам — то же case-правило, что у GET', () => {
    const postBlock = WF.slice(WF.indexOf('POST-пробы'));
    expect(postBlock).toMatch(/case "\$PURL" in/);
    expect(postBlock).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
    // Bearer только в крон-ветке; чужая ветка — последний wildcard-arm
    // (первый '*)' — это хвост паттерна с адресом крон-роутов).
    const foreign = postBlock.slice(postBlock.lastIndexOf('*)'));
    expect(foreign).not.toMatch(/Authorization: Bearer/);
  });

  it('адрес секрета сузился до крон-роутов: домен целиком больше не адресат', () => {
    // Публичные роуты нашего же домена от чужого Bearer получали 401 от
    // Edge-middleware — проба публичного JSON была невозможна (09.08). Заодно
    // это строго уже прежнего правила: мест, куда уходит секрет, стало меньше.
    expect(WF).not.toMatch(/https:\/\/vedarai\.ru\/\*\)/);
    expect(WF.match(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/g) ?? []).toHaveLength(2);
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
