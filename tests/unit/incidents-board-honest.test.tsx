/**
 * Доска «Обстановка» (/safety/incidents) говорит то, что платформа знает
 * (15.10, §0 «честность»).
 *
 * Ссылаются на неё главная (DeskHero, DeskPlanChanges) и навигация. До 15.10:
 * уровни 1/2/3 подписывались «Низкий / Средний / Высокий» (критичное —
 * серединой), пустой список закрытий — «Все маршруты открыты по данным
 * платформы» зелёным щитом, а отказ базы глушился в пустой список и читался
 * как «предупреждений нет».
 *
 * Судится рендером доски.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import IncidentsBoard from '@/components/safety/IncidentsBoard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(cleanup);

const NOW = Date.parse('2026-10-15T08:00:00.000Z');
const FRESH = '2026-10-15T07:55:00.000Z';
const alert = (sev: number, name: string) => ({
  place_name: name, alert_message: null, alert_severity: sev, active_alerts: [`Сводка ${sev}`], ark_id: `ark-${sev}`,
});

describe('уровни — словами источника, не «низкий/средний/высокий»', () => {
  it('1 — предупреждение, 2 — опасно, 3 — чрезвычайная ситуация', () => {
    render(<IncidentsBoard alerts={[alert(3, 'Пляж'), alert(2, 'Река'), alert(1, 'Перевал')]} closed={[]} recomputedAt={FRESH} now={NOW} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Чрезвычайная ситуация');
    expect(text).toContain('Опасно');
    expect(text).toContain('Предупреждение');
    expect(text).not.toMatch(/Низкий|Средний|Высокий/);
  });
});

describe('пусто — не «всё открыто»', () => {
  it('закрытий не отмечено — сказано, что это не проверка', () => {
    render(<IncidentsBoard alerts={[]} closed={[]} recomputedAt={FRESH} now={NOW} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Закрытых мест не отмечено');
    expect(text).toContain('не значит');
    expect(text).not.toMatch(/Все маршруты открыты|Закрытых мест нет/);
    expect(text).toContain('В сводках предупреждений по местам нет');
    expect(text).toContain('не проверка троп');
  });

  it('у закрытого без причины — так и сказано', () => {
    render(<IncidentsBoard alerts={[]} closed={[{ place_name: 'Тропа', closed_reason: null, ark_id: 'a' }]} recomputedAt={FRESH} now={NOW} />);
    expect(screen.getByText('Причина не записана — уточните у МЧС.')).toBeTruthy();
  });
});

describe('сбой — сбой, а не «спокойно»', () => {
  it('отказ базы — «не загрузились» с 112, без «предупреждений нет»', () => {
    render(<IncidentsBoard alerts={null} closed={null} recomputedAt={null} now={NOW} />);
    const failed = screen.getAllByRole('alert').map((n) => n.textContent ?? '');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toContain('Предупреждения не загрузились');
    expect(failed[1]).toContain('Закрытые места не загрузились');
    expect(failed.join(' ')).toContain('112');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/предупреждений по местам нет|не отмечено/);
  });

  it('страница отдаёт доске null при отказе, а не пустой список', () => {
    // Регулярка — только запрет: глушения отказа в пустой список быть не должно.
    const page = readFileSync(join(process.cwd(), 'app/safety/incidents/page.tsx'), 'utf-8');
    expect(page).not.toMatch(/catch\s*\{\s*return \[\];?\s*\}/);
  });
});

describe('свежесть — время пересчёта, а не обещание «каждые 5 минут»', () => {
  it('свежий пересчёт — время по Камчатке', () => {
    render(<IncidentsBoard alerts={[]} closed={[]} recomputedAt={FRESH} now={NOW} />);
    expect(document.body.textContent).toContain('Сводки пересчитаны 15.10, 19:55 по Камчатке');
  });

  it('пересчёт встал — сказано, что список может быть не про сегодня', () => {
    render(<IncidentsBoard alerts={[]} closed={[]} recomputedAt="2026-10-15T01:00:00.000Z" now={NOW} />);
    expect(document.body.textContent).toContain('Пересчёт сводок встал');
  });

  it('времени нет — так и сказано', () => {
    render(<IncidentsBoard alerts={[]} closed={[]} recomputedAt={null} now={NOW} />);
    expect(document.body.textContent).toContain('у нас не записано');
  });
});

describe('карточка маршрута: «Закрытые точки» — отметка, а не проверка', () => {
  it('пустой список закрытий — «администратор не отмечал», а не «нет»', async () => {
    const { default: RouteVerdict } = await import('@/components/routes/RouteVerdict');
    render(
      <RouteVerdict
        routeId="r"
        data={{
          verdict: { status: 'go', code: 'clear', reason: 'Предупреждений нет', unknown: [], label: 'Идти' },
          signals: { alerts: [], volcanoes: [], inSeason: true, weather: null, closures: [] },
        } as unknown as import('@/components/routes/RouteVerdict').VerdictResponse}
      />,
    );
    const row = screen.getByText('Закрытые точки:').parentElement?.textContent ?? '';
    expect(row).toBe('Закрытые точки:администратор не отмечал');
  });
});
