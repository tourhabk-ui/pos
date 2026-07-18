/**
 * Схлопывание оперативных алертов карточки маршрута: зонные (общие для >=2
 * точек) — один раз на маршрут, у точек остаётся только своё.
 * Кейс владельца 2026-07-18: «Рыболовная база „Камчатская Рыбалка"» — 20
 * точек, под каждой одинаковая стена «Вачкажец: проезд закрыт · …».
 */

import { describe, it, expect } from 'vitest';
import { collapseOperationalAlerts, type OperationalAlertRow } from '@/lib/routes/operational-alerts';

const row = (over: Partial<OperationalAlertRow>): OperationalAlertRow => ({
  place_id: 'p',
  place_name: 'Точка',
  is_open: true,
  alert_message: null,
  active_alerts: [],
  alert_severity: 0,
  ...over,
});

describe('collapseOperationalAlerts', () => {
  it('одинаковый алерт у многих точек уходит в zoneAlerts один раз, пустые точки выбрасываются', () => {
    const zone = 'Вачкажец: проезд закрыт 20-27 июля';
    const rows = ['a', 'b', 'c', 'd'].map(id =>
      row({ place_id: id, place_name: `Точка ${id}`, active_alerts: [zone] }),
    );
    const res = collapseOperationalAlerts(rows);
    expect(res.zoneAlerts).toEqual([zone]);
    // Все точки после схлопывания пустые — не показываем ни одной
    expect(res.operationalAlerts).toHaveLength(0);
  });

  it('собственный алерт точки остаётся у точки, зонный — нет', () => {
    const zone = 'Вилючинский перевал: проезд по пропускам';
    const own = 'Мост через Быструю разобран';
    const rows = [
      row({ place_id: 'a', active_alerts: [zone, own] }),
      row({ place_id: 'b', active_alerts: [zone] }),
    ];
    const res = collapseOperationalAlerts(rows);
    expect(res.zoneAlerts).toEqual([zone]);
    expect(res.operationalAlerts).toHaveLength(1);
    expect(res.operationalAlerts[0].placeId).toBe('a');
    expect(res.operationalAlerts[0].activeAlerts).toEqual([own]);
  });

  it('закрытая точка и точечное сообщение не выбрасываются даже без своих алертов', () => {
    const zone = 'Общий алерт района';
    const rows = [
      row({ place_id: 'closed', is_open: false, active_alerts: [zone] }),
      row({ place_id: 'msg', alert_message: 'Дорога перекрыта, объезд через мыс Толстый', active_alerts: [zone] }),
      row({ place_id: 'plain', active_alerts: [zone] }),
    ];
    const res = collapseOperationalAlerts(rows);
    const ids = res.operationalAlerts.map(a => a.placeId);
    expect(ids).toEqual(['closed', 'msg']);
  });

  it('зонные и точечные капы: не больше 3 + счётчик скрытых', () => {
    const zones = ['з1', 'з2', 'з3', 'з4', 'з5'];
    const owns = ['с1', 'с2', 'с3', 'с4'];
    const rows = [
      row({ place_id: 'a', active_alerts: [...zones, ...owns] }),
      row({ place_id: 'b', active_alerts: zones }),
    ];
    const res = collapseOperationalAlerts(rows);
    expect(res.zoneAlerts).toHaveLength(3);
    expect(res.zoneHiddenCount).toBe(2);
    expect(res.operationalAlerts[0].activeAlerts).toHaveLength(3);
    expect(res.operationalAlerts[0].hiddenAlertsCount).toBe(1);
  });

  it('дубли внутри active_alerts одной точки не делают алерт зонным', () => {
    const t = 'Повторённый RSS-алерт';
    const rows = [
      row({ place_id: 'a', active_alerts: [t, t, ` ${t} `] }),
      row({ place_id: 'b', active_alerts: ['другое'] }),
    ];
    const res = collapseOperationalAlerts(rows);
    // t встречается только у точки a (после уникализации) — не зонный
    expect(res.zoneAlerts).toEqual([]);
    expect(res.operationalAlerts.find(x => x.placeId === 'a')?.activeAlerts).toEqual([t]);
  });
});
