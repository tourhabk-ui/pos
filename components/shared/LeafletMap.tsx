'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

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

interface LeafletMapProps {
  markers?: MapMarker[];
  center?: [number, number];
  zoom?: number;
  height?: string;
  className?: string;
  attribution?: boolean;
  onMarkerClick?: (id: string) => void;
  showUserLocation?: boolean;
  locationPriority?: 'battery' | 'highAccuracy';
  track?: { type: string; coordinates: number[][] } | null;
}

const COLOR_MAP: Record<string, string> = {
  red:       '#DC2626',
  blue:      '#2568B0',
  green:     '#3FB950',
  orange:    '#D44A0C',
  purple:    '#8B5CF6',
  darkBlue:  '#1E40AF',
  darkCyan:  '#0891B2',
  lightBlue: '#38BDF8',
  darkGreen: '#15803D',
  teal:      '#0D9488',
  brown:     '#92400E',
  gray:      '#6B7280',
  darkOrange:'#C2410C',
  cyan:      '#06B6D4',
};

const SVG_ICONS: Record<string, (hex: string) => string> = {
  volcano:    h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 2L2 22h20L12 2z" fill="${h}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="2" fill="#fff" opacity="0.8"/></svg>`,
  hot_spring: h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M9 14c0-2 1.5-3 3-3s3 1 3 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  geyser:     h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v6M9 11l3 3 3-3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lake:       h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  mountain:   h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L3 22h18L12 4z" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M8 22l4-8 4 8" stroke="#fff" stroke-width="1" stroke-linecap="round"/></svg>`,
  waterfall:  h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M10 10v8M14 10v8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  beach:      h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.6"/></svg>`,
  viewpoint:  h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M12 10v4l3 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rock:       h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M7 20l2-12 6-4 4 8-3 8H7z" fill="${h}" stroke="#fff" stroke-width="1.5"/></svg>`,
  island:     h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M4 18c0-4 3-8 8-8s8 4 8 8-3.5 6-8 6-8-2-8-6z" fill="${h}" stroke="#fff" stroke-width="1.5"/></svg>`,
  forest:     h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L6 16h12L12 4z" fill="${h}" stroke="#fff" stroke-width="1.5"/><rect x="11" y="16" width="2" height="6" rx="1" fill="#fff" opacity="0.6"/></svg>`,
  river:      h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M8 14c2 0 2-3 4-3s2 3 4 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  bay:        h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M7 18c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>`,
  museum:     h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M3 14l9-8 9 8v6H3v-6z" fill="${h}" stroke="#fff" stroke-width="1.5"/><rect x="7" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="11" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="15" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
  historical: h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v4l2 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  other:      h => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${h}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.5"/></svg>`,
};

function buildPopupHtml(marker: MapMarker): string {
  const hex = COLOR_MAP[marker.color ?? 'blue'] ?? '#2568B0';
  let html = `<div style="font-family:sans-serif;max-width:220px">`;
  html += `<strong style="font-size:13px;color:#111;display:block;margin-bottom:4px">${marker.title}</strong>`;
  if (marker.description) {
    html += `<span style="color:#555;font-size:12px;line-height:1.4">${marker.description}</span>`;
  }
  if (marker.href) {
    html += `<a href="${marker.href}" style="color:${hex};font-size:12px;font-weight:600;text-decoration:none;display:inline-block;margin-top:6px">Смотреть маршрут →</a>`;
  }
  html += `</div>`;
  return html;
}

function populateCluster(
  L: unknown,
  cluster: { clearLayers: () => void; addLayer: (m: unknown) => void },
  map: unknown,
  markers: MapMarker[],
  onMarkerClick?: (id: string) => void,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Lx = L as any; const mx = map as any;
  cluster.clearLayers();

  markers.forEach((marker, idx) => {
    const hex = COLOR_MAP[marker.color ?? 'blue'] ?? '#2568B0';
    const markerId = marker.id ?? `mk_${idx}`;

    if (marker.geometry && marker.geometry.coordinates.length >= 2) {
      const geomHex = COLOR_MAP[marker.geometry.color ?? marker.color ?? 'teal'] ?? '#0D9488';
      const coords = marker.geometry.coordinates as [number, number][];
      if (marker.geometry.type === 'polygon') {
        Lx.polygon(coords, { color: geomHex, weight: marker.geometry.weight ?? 2, fillOpacity: 0.15 }).addTo(mx);
      } else {
        Lx.polyline(coords, { color: geomHex, weight: (marker.geometry.weight ?? 3) + 3, opacity: 0.25, lineCap: 'round', lineJoin: 'round' }).addTo(mx);
        Lx.polyline(coords, { color: geomHex, weight: marker.geometry.weight ?? 3, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(mx);
      }
    }

    const svgFn = SVG_ICONS[marker.category ?? 'other'] ?? SVG_ICONS.other;
    const icon = Lx.divIcon({
      html: svgFn(hex),
      className: 'kh-marker',
      iconSize: [24, 28],
      iconAnchor: [12, 26],
      popupAnchor: [0, -26],
    });

    const m = Lx.marker(marker.coords, { icon });
    if (!marker.suppressBalloon) m.bindPopup(buildPopupHtml(marker), { maxWidth: 260 });
    if (onMarkerClick) m.on('click', () => onMarkerClick(markerId));
    cluster.addLayer(m);
  });
}

export default function LeafletMap({
  markers = [],
  center = [53.0444, 158.6483],
  zoom = 8,
  height = '400px',
  className = '',
  attribution = false,
  onMarkerClick,
  showUserLocation = false,
  locationPriority = 'highAccuracy',
  track,
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clusterRef = useRef<any>(null);
  const mapConfigRef = useRef('');

  useEffect(() => {
    if (!containerRef.current) return;

    const configKey = JSON.stringify({ center, zoom, attribution, showUserLocation, locationPriority, hasTrack: !!track });
    const needsReinit = !mapRef.current || mapConfigRef.current !== configKey;

    let userLocationWatchId: number | null = null;

    Promise.all([
      import('leaflet'),
      import('leaflet.markercluster'),
    ]).then(([L]) => {
      if (!containerRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Lx = L as any;

      if (!needsReinit && mapRef.current && clusterRef.current) {
        populateCluster(Lx, clusterRef.current, mapRef.current, markers, onMarkerClick);
        return;
      }

      mapConfigRef.current = configKey;

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        clusterRef.current = null;
      }

      const map = Lx.map(containerRef.current, {
        center: Lx.latLng(center[0], center[1]),
        zoom,
        zoomControl: false,
        attributionControl: attribution !== false,
        minZoom: 5,
        maxZoom: 12,
        maxBounds: Lx.latLngBounds(Lx.latLng(48.0, 153.0), Lx.latLng(64.0, 178.0)),
        maxBoundsViscosity: 1.0,
      });

      if (!document.getElementById('kh-marker-zfix')) {
        const s = document.createElement('style');
        s.id = 'kh-marker-zfix';
        s.textContent = `.leaflet-marker-pane, .leaflet-popup-pane, .leaflet-tooltip-pane { z-index: 1000 !important; } .leaflet-overlay-pane { z-index: 400 !important; }`;
        document.head.appendChild(s);
      }

      Lx.control.zoom({ position: 'topright' }).addTo(map);

      Lx.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19,
        attribution: attribution !== false ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>' : '',
      }).addTo(map);

      const clusterGroup = Lx.markerClusterGroup({
        chunkedLoading: true,
        chunkInterval: 200,
        chunkDelay: 50,
        maxClusterRadius: 60,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 11,
        iconCreateFunction: (cluster: { getChildCount: () => number }) => {
          const count = cluster.getChildCount();
          const large = count >= 100;
          const medium = count >= 10 && !large;
          const dim = large ? 44 : medium ? 36 : 30;
          const fontSize = large ? 15 : medium ? 13 : 12;
          const bgColor = large ? '#ea580c' : medium ? '#475569' : '#0f172a';
          return Lx.divIcon({
            html: `<div style="background:${bgColor};color:#fff;width:${dim}px;height:${dim}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${fontSize}px;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.25)">${count}</div>`,
            className: 'kh-cluster',
            iconSize: [dim, dim],
          });
        },
      });

      populateCluster(Lx, clusterGroup, map, markers, onMarkerClick);
      map.addLayer(clusterGroup);
      clusterRef.current = clusterGroup;

      if (track?.type === 'LineString' && Array.isArray(track.coordinates) && track.coordinates.length >= 2) {
        const trackLatLngs = track.coordinates
          .filter(c => Array.isArray(c) && c.length >= 2)
          .map(c => Lx.latLng(c[1], c[0]));
        if (trackLatLngs.length >= 2) {
          Lx.polyline(trackLatLngs, { color: '#D44A0C', weight: 6, opacity: 0.35 }).addTo(map);
          Lx.polyline(trackLatLngs, { color: '#D44A0C', weight: 3, opacity: 0.9 }).addTo(map);
          map.fitBounds(Lx.latLngBounds(trackLatLngs), { padding: [24, 24], maxZoom: 13 });
        }
      }

      if (!track && markers.length > 1) {
        map.fitBounds(markers.map(m => m.coords), { padding: [50, 50] });
      }

      if (showUserLocation && typeof navigator !== 'undefined' && navigator.geolocation) {
        const userIcon = Lx.divIcon({
          html: `<div style="position:relative;width:20px;height:20px;"><div style="position:absolute;inset:-8px;border-radius:50%;background:rgba(66,133,244,0.2);animation:kh-pulse 2s ease-out infinite"></div><div style="width:20px;height:20px;border-radius:50%;background:#4285f4;border:3px solid #fff;box-shadow:0 0 8px rgba(66,133,244,0.6)"></div></div>`,
          className: 'kh-user-location',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        const userMarker = Lx.marker([center[0], center[1]], { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
        const accuracyCircle = Lx.circle([center[0], center[1]], { radius: 1000, color: '#4285f4', fillColor: '#4285f4', fillOpacity: 0.1, weight: 1, interactive: false }).addTo(map);

        userLocationWatchId = navigator.geolocation.watchPosition(
          (pos) => {
            const { latitude: lat, longitude: lng, accuracy } = pos.coords;
            userMarker.setLatLng([lat, lng]);
            accuracyCircle.setLatLng([lat, lng]);
            accuracyCircle.setRadius(accuracy);
            if (map.getZoom() >= 12) map.panTo([lat, lng], { animate: true, duration: 0.5 });
          },
          () => { /* silent */ },
          { enableHighAccuracy: locationPriority === 'highAccuracy', maximumAge: 10000, timeout: 15000 }
        );
      }

      mapRef.current = map;
    });

    return () => {
      if (userLocationWatchId !== null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(userLocationWatchId);
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        clusterRef.current = null;
        mapConfigRef.current = '';
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, center, zoom, onMarkerClick, attribution, showUserLocation, locationPriority, track]);

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className={`overflow-clip ${className}`}
    />
  );
}
