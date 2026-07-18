/**
 * lib/routes/operational-alerts.ts
 *
 * Схлопывание оперативных алертов точек маршрута для карточки /routes/[id].
 *
 * Зонные алерты из safety-ingest пишутся во ВСЕ точки района — на маршруте
 * с 20 точками один и тот же текст повторялся под каждой точкой и хоронил
 * точечные закрытия (скрины владельца 2026-07-18, «Рыболовная база
 * „Камчатская Рыбалка"»). Правило: текст, встречающийся у двух и более
 * точек, — зонный, показывается ОДИН раз на маршрут; у точки остаются
 * только её собственные алерты, закрытие (is_open=false) и точечное
 * сообщение (alert_message). Пустые после схлопывания записи выбрасываются.
 */

export interface OperationalAlertRow {
  place_id: string;
  place_name: string;
  is_open: boolean | null;
  alert_message: string | null;
  active_alerts: string[] | null;
  alert_severity: number | null;
}

export interface PlaceOperationalAlert {
  placeId: string;
  placeName: string;
  isOpen: boolean;
  message: string | null;
  activeAlerts: string[];
  hiddenAlertsCount: number;
  severity: number;
}

export interface CollapsedOperationalAlerts {
  /** Общие для района алерты — показывать один раз на маршрут */
  zoneAlerts: string[];
  zoneHiddenCount: number;
  /** Точечные: только собственные алерты точки, закрытия и сообщения */
  operationalAlerts: PlaceOperationalAlert[];
}

const PER_PLACE_CAP = 3;
const ZONE_CAP = 3;

export function collapseOperationalAlerts(rows: OperationalAlertRow[]): CollapsedOperationalAlerts {
  // Страховка от накопленных дублей в active_alerts (RSS-перепубликации)
  const perPlace = rows.map(row => ({
    row,
    alerts: [...new Set((row.active_alerts ?? []).map(t => t.trim()).filter(Boolean))],
  }));

  const alertFreq = new Map<string, number>();
  for (const p of perPlace) {
    for (const t of p.alerts) alertFreq.set(t, (alertFreq.get(t) ?? 0) + 1);
  }
  const zoneSet = new Set([...alertFreq.entries()].filter(([, n]) => n >= 2).map(([t]) => t));
  const zoneAlerts = [...zoneSet];

  const operationalAlerts = perPlace
    .map(({ row, alerts }) => {
      const own = alerts.filter(t => !zoneSet.has(t));
      return {
        placeId: row.place_id,
        placeName: row.place_name,
        isOpen: row.is_open ?? true,
        message: row.alert_message,
        activeAlerts: own.slice(0, PER_PLACE_CAP),
        hiddenAlertsCount: Math.max(0, own.length - PER_PLACE_CAP),
        severity: row.alert_severity != null ? Number(row.alert_severity) : 0,
      };
    })
    .filter(a => !a.isOpen || a.message !== null || a.activeAlerts.length > 0);

  return {
    zoneAlerts: zoneAlerts.slice(0, ZONE_CAP),
    zoneHiddenCount: Math.max(0, zoneAlerts.length - ZONE_CAP),
    operationalAlerts,
  };
}
