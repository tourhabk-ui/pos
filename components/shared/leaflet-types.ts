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
}
