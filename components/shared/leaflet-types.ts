// Standalone types — no Leaflet imports, safe to use in server components and SSR context

export enum MarkerType {
  TOUR = 'tour',
  TRANSFER = 'transfer',
  ACCOMMODATION = 'accommodation',
  RESTAURANT = 'restaurant',
  POI = 'poi',
}

export interface MapMarkerGeometry {
  type: 'polyline' | 'polygon';
  coordinates: [number, number][];
  color?: string;
  weight?: number;
}

export interface MapMarker {
  coords: [number, number];
  title: string;
  description?: string;
  color?: string;
  href?: string;
  type?: MarkerType;
  category?: string;
  geometry?: MapMarkerGeometry;
  id?: string;
  preset?: string;
  suppressBalloon?: boolean;
  /**
   * Активные ограничения места: дорога закрыта, пропускной режим, пожар
   * (issue #836). Показываются в попапе отдельным красным блоком — в поле
   * это важнее описания. Источник — location_real_time_status; в офлайне
   * приходят из скачанного пакета.
   */
  restrictions?: string[];
  /** Когда сняты ограничения (мс). В офлайне показываем возраст данных. */
  restrictionsAt?: number | null;
}
