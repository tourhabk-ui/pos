/**
 * Небо по коду WMO — без импортов: его читает сцена страницы погоды
 * (lib/weather/scene), а её правила зовут и клиентские модули. Модуль с
 * импортами здесь протащил бы в клиентский бандл цепочку до node:crypto
 * (сторож client-no-node-builtins).
 */
export type WeatherSky = 'clear' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

export function weatherSky(code: number | null): WeatherSky {
  if (code === null) return 'cloud';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}
