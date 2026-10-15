'use client';

import WeatherNowChip from '@/components/shared/WeatherNowChip';

interface Props {
  lat: number;
  lng: number;
}

/** Температура у вашего положения на карте — тот же значок, что у карточки места. */
export function MapWeatherChip({ lat, lng }: Props) {
  return <WeatherNowChip lat={lat} lng={lng} whose="вашего положения" glass />;
}
