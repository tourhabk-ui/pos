/**
 * Знак погоды по коду WMO — один на страницу погоды и виджет главной.
 * `wx` — внутри сцены погоды (.wx-scene): цвета сцены, а не темы сайта.
 */
import { Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun } from 'lucide-react';

export function ConditionIcon({ code, isDay, size = 22, wx = false, className = '' }: {
  code: number | null; isDay?: boolean; size?: number; wx?: boolean; className?: string;
}) {
  const tone = wx ? 'text-[var(--wx-icon)]' : 'text-[var(--ocean)]';
  const sun = wx ? 'text-[var(--wx-sun)]' : 'text-[var(--ocean)]';
  const cls = (t: string) => `shrink-0 ${t} ${className}`.trim();
  if (code === null) return <Cloud size={size} aria-hidden className={cls(tone)} />;
  if (code === 0) return isDay === false ? <Moon size={size} aria-hidden className={cls(tone)} /> : <Sun size={size} aria-hidden className={cls(sun)} />;
  if (code <= 2) return isDay === false ? <CloudMoon size={size} aria-hidden className={cls(tone)} /> : <CloudSun size={size} aria-hidden className={cls(tone)} />;
  if (code === 3) return <Cloud size={size} aria-hidden className={cls(tone)} />;
  if (code <= 48) return <CloudFog size={size} aria-hidden className={cls(tone)} />;
  if (code >= 95) return <CloudLightning size={size} aria-hidden className={cls(tone)} />;
  if ((code >= 71 && code <= 77) || code >= 85) return <CloudSnow size={size} aria-hidden className={cls(tone)} />;
  return <CloudRain size={size} aria-hidden className={cls(tone)} />;
}
