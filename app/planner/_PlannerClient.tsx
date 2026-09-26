'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
// Глубокий путь, а не бочка '@/lib/planner': бочка тянет движок вместе с
// пулом PostgreSQL, и он уехал бы в клиентский бандл.
import { parseInterestWords } from '@/lib/planner/interest-words';
import dynamic from 'next/dynamic';
import { Reorder, useDragControls } from 'framer-motion';
import {
  Check, AlertTriangle, Sparkles, Loader,
  Fish, Mountain, PawPrint, Plane,
  Thermometer, Footprints, Wind, Anchor, Snowflake,
  Waves, Flame, Droplets, Droplet, Leaf, GripVertical,
  MapPin, Users, Trash2, Plus, Star, Phone,
  X, ChevronDown, ChevronUp, Truck,
  ArrowRight, ExternalLink, Map as MapIcon, List, Pencil,
  Save, BookmarkCheck, PlaneLanding, PlaneTakeoff, Lock,
  Send, ShieldAlert, Info, Baby, Dumbbell, Wallet,
  ArrowLeftRight, Coffee, CloudOff,
  CheckCircle, Download, MessageCircle, Eye,
  Share2, Copy, UserCheck, Compass,
  ArrowLeft, Minus, CalendarDays, Accessibility, HeartPulse,
} from 'lucide-react';
import { ACTIVITY_MODE_LABEL } from '@/lib/planner/day-mode';
import { TRAVEL_STYLES, TRAVEL_STYLE_LABEL, REST_EVERY_DAYS, suggestRestDays, type TravelStyle } from '@/lib/planner/travel-style';
import { PAGE_ACTION_BAR_VAR } from '@/components/shared/StickyLeadButton';
import { PLANNER_HEADER_OFFSET, CONTENT_BOTTOM_CLEARANCE } from './planner-layout';
import type { MapMarker } from '@/components/shared/leaflet-types';
import { connectorLine, CONNECTOR_TITLES } from '@/lib/map/line-standard';
import { funnelBeacon } from '@/lib/funnel/beacon';
import { useMyReferralCode } from '@/hooks/useMyReferralCode';
import { withReferral } from '@/lib/referral/link';
import type {
  TransportType, DayType, FitnessLevel, BudgetTier,
  SelectItem, DayPlan, TripWarning, PriceBreakdown, Recommendation,
  RoutePoint, Partner, TourPreview, ValidationResult, MobileTab,
} from './planner-types';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

// ─── Constants ────────────────────────────────────────────────────────────────

// Модульная константа: инлайн-литерал center пересоздавал LeafletMap на каждом рендере
const MAP_CENTER: [number, number] = [54.5, 158.5];

const PLACES: SelectItem[] = [
  { id: 'volcano',    label: 'Вулканы',    Icon: Flame },
  { id: 'hot_spring', label: 'Термальные', Icon: Thermometer },
  { id: 'geyser',     label: 'Гейзеры',    Icon: Droplets },
  { id: 'sea',        label: 'Побережье',  Icon: Waves },
  { id: 'mountain',   label: 'Хребты',     Icon: Mountain },
  { id: 'river',      label: 'Реки',       Icon: Waves },
  { id: 'lakes',      label: 'Озёра',      Icon: Droplet },
];

const ACTIVITIES: SelectItem[] = [
  { id: 'trekking',   label: 'Треккинг',         Icon: Footprints },
  { id: 'fishing',    label: 'Рыбалка',          Icon: Fish },
  { id: 'helicopter', label: 'Вертолёт',         Icon: Plane },
  { id: 'bears',      label: 'Медведи',          Icon: PawPrint },
  { id: 'snowmobile', label: 'Снегоходы',        Icon: Snowflake },
  { id: 'boat_trip',  label: 'Морская прогулка', Icon: Anchor },
  { id: 'eco',        label: 'Экотуризм',        Icon: Leaf },
];

const ZONE_LABELS: Record<string, string> = {
  avachinsky: 'Авачинская — вулканы и ПКК',
  western:    'Мильковская — озёра и рыбалка',
  eastern:    'Карагинская — медведи и остров',
  northern:   'Тигильская — гейзеры и север',
};

const ZONE_COLORS: Record<string, string> = {
  avachinsky: 'var(--accent)',
  eastern:    'var(--ocean)',
  northern:   'var(--success)',
  western:    'var(--purple)',
};

const ZONE_COORDS: Record<string, [number, number]> = {
  avachinsky: [52.80, 158.80],
  western:    [55.33, 157.12],
  eastern:    [55.20, 161.42],
  northern:   [57.73, 158.71],
};

const ACTIVITY_LABEL: Record<string, string> = {
  trekking:   'Треккинг',
  fishing:    'Рыбалка',
  helicopter: 'Вертолёт',
  bears:      'Медведи',
  snowmobile: 'Снегоходы',
  boat_trip:  'Катер',
  volcano:    'Вулкан',
  hot_spring: 'Термальные',
  geyser:     'Гейзеры',
  sea:        'Побережье',
  mountain:   'Горы',
  river:      'Реки',
  lakes:      'Озёра',
  eco:        'Экотуризм',
};

const INTEREST_PRICE: Record<string, [number, number]> = {
  trekking:   [3000,  8000],
  fishing:    [8000,  20000],
  bears:      [15000, 35000],
  helicopter: [25000, 60000],
  thermal:    [2000,  6000],
  hot_spring: [2000,  5000],
  boat_trip:  [5000,  15000],
  snowmobile: [8000,  18000],
  volcano:    [5000,  12000],
  geyser:     [8000,  20000],
  mountain:   [3000,  9000],
  sea:        [4000,  12000],
  river:      [5000,  15000],
  lakes:      [3000,  10000],
  eco:        [2000,   8000],
};

const TRANSPORT_OPTIONS: Record<TransportType, { label: string; Icon: React.ElementType; priceAdd: number }> = {
  walking:    { label: 'Пешком',   Icon: Footprints, priceAdd: 0 },
  jeep:       { label: 'Джип',     Icon: Truck,      priceAdd: 3000 },
  boat:       { label: 'Катер',    Icon: Anchor,     priceAdd: 8000 },
  helicopter: { label: 'Вертолёт', Icon: Plane,      priceAdd: 25000 },
};

const ACTIVITY_DEFAULT_TRANSPORT: Record<string, TransportType> = {
  trekking: 'walking', fishing: 'boat', bears: 'helicopter',
  helicopter: 'helicopter', thermal: 'walking', hot_spring: 'walking',
  boat_trip: 'boat', snowmobile: 'jeep', volcano: 'jeep',
  geyser: 'helicopter', mountain: 'walking', sea: 'boat', river: 'boat',
};

const DEFAULT_PRICE: [number, number] = [3000, 10000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today(): string { return new Date().toISOString().split('T')[0]; }
function maxDate(): string {
  const d = new Date(); d.setFullYear(d.getFullYear() + 2); return d.toISOString().split('T')[0];
}
function calcDays(from: string, to: string): number | null {
  if (!from || !to) return null;
  const diff = new Date(to).getTime() - new Date(from).getTime();
  return diff > 0 ? Math.round(diff / 86400000) : null;
}
function fmt(n: number): string { return n.toLocaleString('ru-RU'); }
function trunc(s: string | null | undefined, len: number): string {
  if (!s) return '';
  return s.length > len ? s.slice(0, len).trimEnd() + '...' : s;
}

function guessZone(lat: number, lng: number): DayPlan['zone'] {
  const entries = Object.entries(ZONE_COORDS) as [string, [number, number]][];
  let best = 'avachinsky';
  let bestDist = Infinity;
  for (const [zone, coords] of entries) {
    const dist = Math.abs(lat - coords[0]) + Math.abs(lng - coords[1]);
    if (dist < bestDist) { bestDist = dist; best = zone; }
  }
  return best as DayPlan['zone'];
}

function routeToDayPlan(route: RoutePoint, dayNum: number): DayPlan {
  const activity = route.activity_type ?? 'trekking';
  const [priceFrom, priceTo] = INTEREST_PRICE[activity] ?? DEFAULT_PRICE;
  const transport = ACTIVITY_DEFAULT_TRANSPORT[activity] ?? 'walking';
  const zone = guessZone(route.lat, route.lng);
  const zoneTransports = ZONE_TRANSPORTS[zone] ?? ['walking', 'jeep'];
  return {
    day: dayNum,
    type: 'activity',
    zone,
    title: route.title,
    description: '',
    activityType: activity,
    priceFrom, priceTo,
    coords: [route.lat, route.lng],
    defaultTransport: transport,
    allowedTransports: zoneTransports.filter(t => t === transport || ['walking', 'jeep'].includes(t)) as TransportType[],
    difficulty: 'moderate',
    childFriendly: true,
    minChildAge: 0,
    dayWarnings: [],
  };
}

// ─── Анкета по шагам ──────────────────────────────────────────────────────────

type PlannerStep = 1 | 2 | 3 | 4;

/** Порядок шагов — решение владельца 26.09; сторож tests/unit/planner-steps.test.ts. */
const PLANNER_STEPS: ReadonlyArray<{ n: PlannerStep; title: string; lead: string }> = [
  { n: 1, title: 'Когда', lead: 'Даты и время рейсов — от них считаются дни на Камчатке.' },
  { n: 2, title: 'Кто едет', lead: 'Состав группы и то, что важно учесть в пути.' },
  { n: 3, title: 'Как хотите ехать', lead: 'Сами, с оператором или вперемешку, и сколько дней отдыхать.' },
  { n: 4, title: 'Что интересно', lead: 'Места и занятия — из них соберём дни.' },
];

/** Потолок заметки о здоровье — тот же, что проверяет /api/planner/recommend. */
const HEALTH_NOTES_MAX = 300;

/** «5 авг.» — дата сводки анкеты. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** «1 день / 2 дня / 5 дней». */
function pluralDaysRu(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'дней';
  const m10 = n % 10;
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}

/** Сегментированный выбор: одна строка, крупные цели касания. */
function Segmented<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className="grid gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={active} onClick={() => onChange(o.value)}
            className={`min-h-[44px] rounded-md px-2 text-sm font-medium leading-tight transition-colors duration-200 motion-reduce:transition-none ${
              active
                ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SelectGroup({ title, items, selected, onToggle }: {
  title: string; items: SelectItem[]; selected: string[]; onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">{title}</p>
      <div className="flex flex-wrap gap-2">
        {items.map(({ id, label, Icon }) => {
          const active = selected.includes(id);
          return (
            <button key={id} type="button" onClick={() => onToggle(id)}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all border text-xs font-medium select-none min-h-[44px] ${
                active
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white shadow-sm'
                  : 'border-[var(--border)] text-[var(--text-secondary)] bg-[var(--bg-card)] active:bg-[var(--bg-hover)]'
              }`}>
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Boat only makes sense for coastal/river zones; helicopter not for sea crossings only
const ZONE_TRANSPORTS: Record<string, TransportType[]> = {
  avachinsky: ['walking', 'jeep', 'helicopter'],
  northern:   ['walking', 'jeep', 'helicopter'],
  eastern:    ['walking', 'jeep', 'helicopter', 'boat'],
  western:    ['walking', 'jeep', 'boat'],
};

function TransportSelector({ selected, onChange, zone }: {
  selected: TransportType; onChange: (t: TransportType) => void; zone?: string;
}) {
  const allowed = zone ? (ZONE_TRANSPORTS[zone] ?? Object.keys(TRANSPORT_OPTIONS) as TransportType[]) : Object.keys(TRANSPORT_OPTIONS) as TransportType[];
  // if currently selected transport is not allowed in this zone, use first allowed
  const effective = allowed.includes(selected) ? selected : allowed[0];
  return (
    <div className="flex gap-1">
      {allowed.map(key => {
        const { label, Icon, priceAdd } = TRANSPORT_OPTIONS[key];
        const active = effective === key;
        return (
          <button key={key} type="button"
            title={`${label}${priceAdd > 0 ? ` (+${fmt(priceAdd)} ₽)` : ''}`}
            onClick={() => onChange(key)}
            className={`flex items-center justify-center w-8 h-8 rounded-md transition-all border text-xs ${
              active
                ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] bg-[var(--bg-hover)]'
            }`}>
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: 'Легкий', moderate: 'Средний', hard: 'Сложный',
};

// ─── Day card (DnD-aware) ─────────────────────────────────────────────────────

interface DayCardProps {
  day: DayPlan;
  idx: number;
  isEditing: boolean;
  transport: TransportType;
  flightBadge?: string;
  isLocked?: boolean;
  isConfirmed?: boolean;
  topTour?: TourPreview;
  onToggleEdit: (dayId: number) => void;
  onTransportChange: (dayNum: number, t: TransportType) => void;
  onShowPartners: (activityType: string) => void;
  onDelete: (dayNum: number) => void;
  onShowMap: () => void;
  onConfirm: (dayNum: number) => void;
  onRef: (el: HTMLElement | null) => void;
}

function DayCard({
  day, idx, isEditing, transport, flightBadge, isLocked, isConfirmed, topTour,
  onToggleEdit, onTransportChange, onShowPartners, onDelete, onShowMap, onConfirm, onRef,
}: DayCardProps) {
  const dragControls = useDragControls();
  const { Icon: TransIcon } = TRANSPORT_OPTIONS[transport];
  const FlightIcon = idx === 0 ? PlaneLanding : PlaneTakeoff;
  const [showDetail, setShowDetail] = useState(false);

  // Day type styling
  const isSpecialDay = day.type !== 'activity';
  const dayTypeConfig: Record<DayType, { label: string; Icon: React.ElementType; color: string }> = {
    arrival:   { label: 'Прилёт',    Icon: PlaneLanding,  color: 'var(--ocean)' },
    departure: { label: 'Вылет',     Icon: PlaneTakeoff,  color: 'var(--ocean)' },
    travel:    { label: 'Переезд',   Icon: ArrowLeftRight, color: 'var(--warning)' },
    rest:      { label: 'Отдых',     Icon: Coffee,         color: 'var(--success)' },
    buffer:    { label: 'Резерв',    Icon: CloudOff,       color: 'var(--text-muted)' },
    activity:  { label: '',          Icon: Sparkles,       color: 'var(--accent)' },
  };
  const typeConf = dayTypeConfig[day.type] ?? dayTypeConfig.activity;
  // Род активного дня (владелец 25.09: «сегодня сам, завтра с оператором,
  // потом отдых»). Производит движок; нет поля — метки нет, не угадываем.
  const modeConfig = {
    operator: { Icon: UserCheck, color: 'var(--accent)' },
    self:     { Icon: Footprints, color: 'var(--success)' },
    open:     { Icon: Compass, color: 'var(--text-muted)' },
  } as const;
  const mode = day.type === 'activity' && day.activityMode ? day.activityMode : null;

  return (
    <Reorder.Item
      value={day}
      dragControls={dragControls}
      dragListener={false}
      className={`rounded-lg select-none transition-all ${
        isConfirmed
          ? 'bg-[var(--bg-card)] border-2 border-[var(--success)]/40 ring-1 ring-[var(--success)]/10'
          : isEditing
          ? 'bg-[var(--bg-card)] border-2 border-[var(--accent)] ring-2 ring-[var(--accent)]/20'
          : 'bg-[var(--bg-card)] border border-[var(--border)]'
      }`}
      style={{ listStyle: 'none' }}
    >
      <div ref={onRef}>
        {/* Row 1 — clickable to toggle edit */}
        <div
          className="flex items-center gap-2 px-3 pt-3 pb-1.5 cursor-pointer"
          onClick={() => onToggleEdit(day.day)}
        >
          {isConfirmed
            ? <CheckCircle className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
            : isLocked
            ? <Lock className="w-3.5 h-3.5 text-[var(--text-muted)]/40 shrink-0" />
            : <GripVertical
                className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 cursor-grab active:cursor-grabbing touch-none"
                onPointerDown={(e) => { e.stopPropagation(); dragControls.start(e); }}
              />
          }
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 transition-all ${
              isEditing ? 'ring-2 ring-[var(--accent)]/40' : ''
            }`}
            style={{ background: ZONE_COLORS[day.zone] ?? 'var(--accent)' }}
          >
            {idx + 1}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-xs font-medium text-[var(--text-primary)] truncate">{day.title}</p>
              {isSpecialDay && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 whitespace-nowrap"
                  style={{ background: `color-mix(in srgb, ${typeConf.color} 15%, transparent)`, color: typeConf.color }}>
                  <typeConf.Icon className="w-2.5 h-2.5" />
                  {typeConf.label}
                </span>
              )}
              {mode && (() => {
                const m = modeConfig[mode];
                return (
                  <span
                    title={ACTIVITY_MODE_LABEL[mode].hint}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 whitespace-nowrap"
                    style={{ background: `color-mix(in srgb, ${m.color} 15%, transparent)`, color: m.color }}
                  >
                    <m.Icon className="w-2.5 h-2.5" aria-hidden />
                    {ACTIVITY_MODE_LABEL[mode].label}
                  </span>
                );
              })()}
              {flightBadge && !isSpecialDay && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--ocean)]/15 text-[var(--ocean)] text-[9px] font-bold shrink-0 whitespace-nowrap">
                  <FlightIcon className="w-2.5 h-2.5" />
                  {flightBadge}
                </span>
              )}
            </div>
            <p className="text-[10px] text-[var(--text-muted)]">
              {ZONE_LABELS[day.zone] ?? day.zone}
              {isEditing && (
                <span className="ml-1.5 text-[var(--accent)] font-medium">— редактирование</span>
              )}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-semibold text-[var(--accent)]">от {fmt(day.priceFrom)} ₽</p>
            <p className="text-[10px] text-[var(--text-muted)]">до {fmt(day.priceTo)} ₽</p>
          </div>
        </div>
        {/* Row 2 — transport + actions */}
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
          {day.type === 'activity' && !isConfirmed && (
            <TransportSelector selected={transport} onChange={t => onTransportChange(day.day, t)} zone={day.zone} />
          )}
          {day.description && day.type !== 'activity' && (
            <p className="text-[10px] text-[var(--text-muted)] italic">{day.description}</p>
          )}
          <div className="flex-1" />
          {/* Detail toggle */}
          <button type="button" title="Подробнее" onClick={(e) => { e.stopPropagation(); setShowDetail(v => !v); }}
            className={`w-7 h-7 flex items-center justify-center rounded-md border transition-colors bg-[var(--bg-hover)] ${
              showDetail
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]'
            }`}>
            <Eye className="w-3.5 h-3.5" />
          </button>
          {isEditing && (
            <button type="button" title="Показать на карте" onClick={onShowMap}
              className="lg:hidden w-7 h-7 flex items-center justify-center rounded-md border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10 transition-colors">
              <MapIcon className="w-3.5 h-3.5" />
            </button>
          )}
          <button type="button" title="Операторы" onClick={() => onShowPartners(day.activityType)}
            className="w-7 h-7 flex items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--ocean)] hover:border-[var(--ocean)] transition-colors bg-[var(--bg-hover)]">
            <Users className="w-3.5 h-3.5" />
          </button>
          {!isLocked && !isConfirmed && (
            <button type="button" title="Удалить день" onClick={() => onDelete(day.day)}
              className="w-7 h-7 flex items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--danger)] hover:border-[var(--danger)] transition-colors bg-[var(--bg-hover)]">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* Top matching tour — ведёт на КАРТОЧКУ ТУРА с бронью, не на страницу
            оператора: id тура в руках, а «план, который бронирует» — наше
            отличие от 84 планировщиков TAAFT, которые только планируют
            (разведка 08.08). Оператор виден на самой карточке. */}
        {topTour && day.type === 'activity' && (
          <a
            href={`/catalog/tours/${topTour.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Открыть тур и забронировать"
            className="flex items-center justify-between gap-2 mx-3 mb-2.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-hover)] border border-[var(--border)] hover:border-[var(--ocean)] transition-colors"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Star className="w-3 h-3 text-[var(--warning)] shrink-0" />
              <span className="text-[10px] text-[var(--text-secondary)] truncate">{topTour.title}</span>
            </div>
            <span className="text-[10px] font-semibold text-[var(--ocean)] whitespace-nowrap">
              от {Number(topTour.base_price).toLocaleString('ru-RU')} ₽ · забронировать
            </span>
          </a>
        )}
        {/* Day warnings */}
        {day.dayWarnings && day.dayWarnings.length > 0 && (
          <div className="mx-3 mb-2 space-y-1">
            {day.dayWarnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 px-2 py-1 rounded bg-[var(--warning)]/8 text-[10px] text-[var(--warning)]">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
        {/* Expandable detail panel */}
        {showDetail && (
          <div className="mx-3 mb-2.5 p-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-2.5">
            {day.description && (
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{day.description}</p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                <MapPin className="w-3 h-3" />
                <span>{ZONE_LABELS[day.zone] ?? day.zone}</span>
              </div>
              {day.type === 'activity' && (
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                  <Dumbbell className="w-3 h-3" />
                  <span>{DIFFICULTY_LABEL[day.difficulty] ?? day.difficulty}</span>
                </div>
              )}
              {day.minChildAge > 0 && (
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                  <Baby className="w-3 h-3" />
                  <span>от {day.minChildAge} лет</span>
                </div>
              )}
              {day.childFriendly && day.minChildAge === 0 && (
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--success)]">
                  <Baby className="w-3 h-3" />
                  <span>для всех возрастов</span>
                </div>
              )}
              {day.allowedTransports.length > 1 && (
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                  <Truck className="w-3 h-3" />
                  <span>{day.allowedTransports.map(t => TRANSPORT_OPTIONS[t].label).join(', ')}</span>
                </div>
              )}
            </div>
            {day.type === 'activity' && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                <Wallet className="w-3 h-3" />
                <span>{fmt(day.priceFrom)} — {fmt(day.priceTo)} ₽ на человека</span>
              </div>
            )}
            {day.coords[0] !== 53.01 && (
              <div className="text-[10px] text-[var(--text-muted)]">
                {day.coords[0].toFixed(4)}, {day.coords[1].toFixed(4)}
              </div>
            )}
            {/* Confirm day button */}
            {!isConfirmed && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onConfirm(day.day); }}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-[var(--success)] text-xs font-medium hover:bg-[var(--success)]/20 transition-colors">
                <CheckCircle className="w-3.5 h-3.5" />
                Подтвердить день
              </button>
            )}
            {isConfirmed && (
              <div className="flex items-center gap-1.5 py-1.5 text-xs text-[var(--success)] font-medium">
                <CheckCircle className="w-3.5 h-3.5" />
                День подтверждён
              </div>
            )}
          </div>
        )}
      </div>
    </Reorder.Item>
  );
}

// Route detail card — shown over the map when a suggestion marker is clicked
function RouteDetailCard({ route, days, editingDayId, onReplace, onAddDay, onClose }: {
  route: RoutePoint;
  days: DayPlan[];
  editingDayId: number | null;
  onReplace: (dayNum: number) => void;
  onAddDay: () => void;
  onClose: () => void;
}) {
  const defaultTarget = editingDayId ?? days[0]?.day ?? 0;
  const [targetDay, setTargetDay] = useState<number>(defaultTarget);
  const actLabel = route.activity_type ? (ACTIVITY_LABEL[route.activity_type] ?? route.activity_type) : null;

  // Auto-update target when editingDayId changes
  useEffect(() => {
    if (editingDayId !== null) setTargetDay(editingDayId);
  }, [editingDayId]);

  const editingIdx = days.findIndex(d => d.day === editingDayId);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg overflow-hidden">
      <div className="flex items-start gap-2 px-3 pt-3 pb-2">
        <MapPin className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--text-primary)] leading-tight">{route.title}</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {actLabel && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">
                {actLabel}
              </span>
            )}
            {route.location_type && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--ocean)]/10 text-[var(--ocean)]">
                {route.location_type}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {route.description && (
        <p className="px-3 pb-2 text-xs text-[var(--text-secondary)] leading-relaxed">
          {trunc(route.description, 140)}
        </p>
      )}

      <div className="px-3 pb-3 space-y-2 border-t border-[var(--border)] pt-2">
        {/* In edit mode: direct replace for the editing day */}
        {editingDayId !== null && editingIdx >= 0 && (
          <button
            onClick={() => onReplace(editingDayId)}
            className="w-full ds-btn ds-btn-primary py-2 text-xs font-medium flex items-center justify-center gap-1.5"
          >
            <ArrowRight className="w-3.5 h-3.5" />
            Заменить День {editingIdx + 1}
          </button>
        )}

        {/* Select a different day to replace */}
        {days.length > 0 && editingDayId === null && (
          <div className="flex items-center gap-2">
            <select
              value={targetDay}
              onChange={e => setTargetDay(Number(e.target.value))}
              className="ds-input flex-1 text-xs py-1.5"
            >
              {days.map((d, i) => (
                <option key={d.day} value={d.day}>День {i + 1}: {trunc(d.title, 22)}</option>
              ))}
            </select>
            <button
              onClick={() => onReplace(targetDay)}
              className="ds-btn ds-btn-primary px-3 py-1.5 text-xs font-medium flex items-center gap-1 shrink-0"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              Заменить
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button onClick={onAddDay}
            className="ds-btn ds-btn-secondary flex-1 py-1.5 text-xs font-medium flex items-center justify-center gap-1">
            <Plus className="w-3.5 h-3.5" />
            Добавить в план
          </button>
          <a href={`/routes/${route.id}`} target="_blank" rel="noopener noreferrer"
            className="ds-btn ds-btn-secondary py-1.5 px-2 text-xs flex items-center gap-1">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

// Partners mini-modal
function PartnersModal({ activityType, onClose }: {
  activityType: string; onClose: () => void;
}) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/planner/partners?activity_type=${encodeURIComponent(activityType)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) setPartners(data.data as Partner[]);
        else setError(data.error ?? 'Ошибка');
      })
      .catch(() => setError('Нет соединения'))
      .finally(() => setLoading(false));
  }, [activityType]);

  const label = [...ACTIVITIES, ...PLACES].find(a => a.id === activityType)?.label ?? activityType;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-[var(--bg-card)] rounded-lg border border-[var(--border)] w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Операторы</p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{label}</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-2">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-[var(--text-muted)]">
              <Loader className="w-4 h-4 animate-spin" />
              <span className="text-sm">Загружаем операторов...</span>
            </div>
          )}
          {!loading && error && (
            <p className="text-sm text-[var(--danger)] p-3">{error}</p>
          )}
          {!loading && !error && partners.length === 0 && (
            <div className="text-center py-8">
              <Users className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2" />
              <p className="text-sm text-[var(--text-secondary)]">Операторы появятся скоро</p>
            </div>
          )}
          {!loading && partners.map(p => {
            const phone = Array.isArray(p.contacts) ? p.contacts[0]?.phone : null;
            return (
              <div key={p.id} className="bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{p.name}</p>
                  {Number(p.rating) > 0 && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Star className="w-3 h-3 text-[var(--warning)] fill-current" />
                      <span className="text-xs font-medium text-[var(--text-primary)]">{Number(p.rating).toFixed(1)}</span>
                    </div>
                  )}
                </div>
                {p.short_description && (
                  <p className="text-xs text-[var(--text-secondary)] line-clamp-2">{p.short_description}</p>
                )}
                {p.has_matching_tours && (
                  <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)]">
                    Туры для этой активности
                  </span>
                )}
                {phone && (
                  <a
                    href={`tel:${phone}`}
                    className="flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline"
                    /* Открытый контакт исполнителя — действие исполнения
                       (стратегия 14.08, шаг словаря lib/funnel/steps). */
                    onClick={() => funnelBeacon('partner_contact', p.id)}
                  >
                    <Phone className="w-3 h-3" />{phone}
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="w-full ds-btn ds-btn-secondary py-2 text-sm">Закрыть</button>
        </div>
      </div>
    </div>
  );
}

// ─── Mobile Tab Switcher ─────────────────────────────────────────────────────

function MobileTabBar({ active, onChange, editingDay }: {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  editingDay: { idx: number; title: string } | null;
}) {
  return (
    <div className="lg:hidden border-b border-[var(--border)] bg-[var(--bg-primary)]">
      {editingDay && (
        <div className="px-4 py-2 bg-[var(--accent)]/10 border-b border-[var(--accent)]/20 flex items-center gap-2">
          <Pencil className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
          <p className="text-xs text-[var(--accent)] font-medium truncate">
            Замена для Дня {editingDay.idx + 1}: {editingDay.title}
          </p>
        </div>
      )}
      <div className="flex">
        <button
          onClick={() => onChange('plan')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            active === 'plan'
              ? 'text-[var(--accent)] border-b-2 border-[var(--accent)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <List className="w-4 h-4" />
          План
        </button>
        <button
          onClick={() => onChange('map')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            active === 'map'
              ? 'text-[var(--accent)] border-b-2 border-[var(--accent)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <MapIcon className="w-4 h-4" />
          Карта
        </button>
      </div>
    </div>
  );
}

// ─── Companion widget (trip helper) ──────────────────────────────────────────

function CompanionWidget({ days, arrival, departure }: {
  days: DayPlan[];
  arrival: string;
  departure: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    const text = message.trim();
    if (!text || loading) return;
    setMessage('');
    setMessages(prev => [...prev, { role: 'user', text }]);
    setLoading(true);

    const daysSummary = days.map((d, i) =>
      `День ${i + 1}: ${d.title} (${d.zone}, ${d.activityType})`
    ).join('\n');

    try {
      const res = await fetch('/api/planner/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          context: `Маршрут: ${arrival || '?'} — ${departure || '?'}, ${days.length} дней.\n${daysSummary}`,
        }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.success ? data.reply : (data.error ?? 'Ошибка'),
      }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Ошибка соединения' }]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-[var(--accent)] text-white shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
        title="Помощник путешественника"
      >
        <MessageCircle className="w-5 h-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-80 max-h-[70vh] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-hover)]">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-[var(--accent)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Помощник</span>
        </div>
        <button onClick={() => setOpen(false)}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[200px] max-h-[400px]">
        {messages.length === 0 && (
          <div className="text-center py-8 space-y-2">
            <MessageCircle className="w-8 h-8 text-[var(--text-muted)]/30 mx-auto" />
            <p className="text-xs text-[var(--text-muted)]">
              Задайте любой вопрос о маршруте, локациях, погоде, экипировке или безопасности
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed ${
              m.role === 'user'
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border)]'
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
              <Loader className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-[var(--border)] p-2 flex gap-2">
        <input
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
          placeholder="Ваш вопрос..."
          className="flex-1 ds-input text-xs py-2"
        />
        <button
          onClick={sendMessage}
          disabled={loading || !message.trim()}
          className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--accent)] text-white disabled:opacity-40 transition-opacity shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const MOOD_PRESETS: Record<string, { activities: string[]; places: string[] }> = {
  extreme:  { activities: ['trekking'],          places: ['volcano'] },
  relax:    { activities: [],                    places: ['hot_spring', 'sea'] },
  family:   { activities: ['bears', 'helicopter'], places: ['geyser'] },
  photo:    { activities: ['bears'],             places: ['volcano', 'geyser'] },
  first:    { activities: ['trekking'],          places: ['hot_spring', 'volcano'] },
};

/**
 * Ключ движка → id плитки на этом экране.
 *
 * Совпадают почти все, поэтому карта только для расхождений: у движка
 * активность зовётся `thermal`, а плитка здесь — `hot_spring`. Без этой
 * строки «хотим термальные» приходило бы ключом, которого нет ни в
 * `PLACES`, ни в `ACTIVITIES`, и молча пропадало.
 */
const ENGINE_KEY_TO_TILE: Record<string, string> = {
  thermal: 'hot_spring',
};

const PLACE_IDS = new Set(PLACES.map((p) => p.id));
const ACTIVITY_IDS = new Set(ACTIVITIES.map((a) => a.id));

/**
 * Интересы из ссылки → две группы плиток этого экрана.
 *
 * ── Зачем (замер 19.09, починка 20.09) ──────────────────────────────────
 *
 * `lib/mcp/handoff-targets.ts` отдаёт туриста внешней модели по адресу
 * `/planner?days=7&interests=вулканы и медведи`, карточка тура — по
 * `/planner?hint=fishing`. Экран читал из URL ТОЛЬКО `mood` и оба набора
 * выбрасывал: человек приходил на пустую форму и заполнял её заново. Два
 * производителя, ноль потребителей — провод в никуда (§10.09).
 *
 * Разбор словарём, а не выдумкой: слово, которого в словаре нет, не
 * подменяется похожим — оно просто не даёт плитки.
 */
function tilesFromLink(interestsText: string | null, hint: string | null): {
  places: string[]; activities: string[];
} {
  const keys = new Set<string>();
  if (interestsText) for (const k of parseInterestWords(interestsText)) keys.add(k);
  // `hint` — уже ключ активности (activity_type тура), а не свободный текст.
  if (hint) keys.add(hint.trim().toLowerCase());

  const places: string[] = [];
  const activities: string[] = [];
  for (const key of keys) {
    const tile = ENGINE_KEY_TO_TILE[key] ?? key;
    if (PLACE_IDS.has(tile)) places.push(tile);
    else if (ACTIVITY_IDS.has(tile)) activities.push(tile);
    // Ключ, которому нет плитки, молча пропадает — и это правильно: рисовать
    // выбор, которого на экране нет, значило бы обещать несуществующий фильтр.
  }
  return { places, activities };
}

/** Дата через N дней от сегодня, YYYY-MM-DD. */
function isoInDays(offset: number): string {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

export function PlannerClient({ initialUserId }: { initialUserId?: string | null }) {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Interest + date
  //
  // Приход по ссылке: `mood` — плитка намерения с главной; `interests` и
  // `hint` — то, что турист уже назвал в чате или на карточке тура. Второе
  // приоритетнее первого: это его собственные слова, а не выбранный за него
  // пресет настроения.
  const fromLink = useMemo(
    () => tilesFromLink(searchParams.get('interests'), searchParams.get('hint')),
    [searchParams],
  );

  const [places, setPlaces]         = useState<string[]>(() => {
    if (fromLink.places.length > 0) return fromLink.places;
    const mood = searchParams.get('mood');
    return mood && MOOD_PRESETS[mood] ? MOOD_PRESETS[mood].places : [];
  });
  const [activities, setActivities] = useState<string[]>(() => {
    if (fromLink.activities.length > 0) return fromLink.activities;
    const mood = searchParams.get('mood');
    return mood && MOOD_PRESETS[mood] ? MOOD_PRESETS[mood].activities : [];
  });

  // `days` из ссылки заполняет ОБА поля дат и остаётся видимым: турист
  // называл длительность, а не даты, поэтому старт берётся «через месяц» —
  // тот же, на который считает Кузьмич. Поля обычные, правятся руками;
  // подставить длительность молча, не показав дат, значило бы решить за
  // человека и не сказать об этом.
  const linkDays = useMemo(() => {
    const raw = searchParams.get('days');
    const n = raw && /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
    return n >= 3 && n <= 21 ? n : 0;
  }, [searchParams]);

  const [arrival, setArrival]       = useState(() => (linkDays > 0 ? isoInDays(30) : ''));
  const [departure, setDeparture]   = useState(() => (linkDays > 0 ? isoInDays(30 + linkDays) : ''));
  const [flightArrival, setFlightArrival]     = useState('');
  const [flightDeparture, setFlightDeparture] = useState('');
  const [flightArrivalTime, setFlightArrivalTime]       = useState('');
  const [flightDepartureTime, setFlightDepartureTime]   = useState('');
  const [needsAirportTransfer, setNeedsAirportTransfer] = useState(false);

  // Group profile
  const [adults, setAdults] = useState(2);
  const [childAges, setChildAges] = useState<number[]>([]);
  const [fitnessLevel, setFitnessLevel] = useState<FitnessLevel>('moderate');
  const [budgetTier, setBudgetTier] = useState<BudgetTier>('comfort');
  const [seasickness, setSeasickness] = useState(false);
  const [riskMode, setRiskMode] = useState<'safe_only' | 'adventure' | 'available'>('safe_only');
  // Здоровье — только в /api/planner/recommend (наш движок). Не в чат, не в
  // заявку, не в сохранённый маршрут, не в модель — сторож planner-health-stays-local.
  const [healthNotes, setHealthNotes] = useState('');
  const [mobilityLevel, setMobilityLevel] = useState<'full' | 'limited' | 'wheelchair'>('full');
  const [travelStyle, setTravelStyle] = useState<TravelStyle>('mixed');
  const [restDays, setRestDays] = useState(0);
  // Пока человек не трогал счётчик, дни отдыха считаются от дат (suggestRestDays).
  const [restManual, setRestManual] = useState(false);

  // Анкета по шагам
  const [step, setStep] = useState<PlannerStep>(1);
  const [formOpen, setFormOpen] = useState(true);
  const [stepError, setStepError] = useState('');
  const [chatNote, setChatNote] = useState('');
  const stepBarRef = useRef<HTMLDivElement>(null);
  const planScrollRef = useRef<HTMLDivElement>(null);

  // Trip persistence
  const [tripId, setTripId]         = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [shareUrl, setShareUrl]     = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [shareCopied, setShareCopied] = useState(false);
  // «Отправь группе свой план» (стратегия 14.08): ссылка залогиненного несёт
  // его реферальную метку. Код спрашивается заранее — к нажатию ссылка готова.
  const myReferralCode = useMyReferralCode(!!initialUserId);

  // Plan
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [days, setDays]   = useState<DayPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');
  const [showItinerary, setShowItinerary] = useState(false);

  // Level 2
  const [transportByDay, setTransportByDay] = useState<Record<number, TransportType>>({});
  const [partnersModal, setPartnersModal]   = useState<{ activityType: string } | null>(null);

  // Background route markers
  const [bgRoutes, setBgRoutes] = useState<RoutePoint[]>([]);
  const [bgLoading, setBgLoading] = useState(false);

  // Selected route on map (clicked suggestion)
  const [selectedRoute, setSelectedRoute] = useState<RoutePoint | null>(null);

  // Edit mode: which day is being edited (null = overview)
  const [editingDayId, setEditingDayId] = useState<number | null>(null);

  // Mobile tab
  const [mobileTab, setMobileTab] = useState<MobileTab>('plan');

  // Lead form
  const [showContact, setShowContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactComment, setContactComment] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [contactError, setContactError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Refs for scrolling to day card
  const dayRefs = useRef<Map<number, HTMLElement>>(new Map());

  // TripBuilder v2: AI chat fill
  const [chatInput, setChatInput]   = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  // TripBuilder v2: marketplace tours per activity type
  const [toursPerActivity, setToursPerActivity] = useState<Record<string, TourPreview>>({});
  const loadedActivitiesRef = useRef<Set<string>>(new Set());

  // TripBuilder v2: AI route validation after DnD
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Day confirmation
  const [confirmedDays, setConfirmedDays] = useState<Set<number>>(new Set());

  const allInterests = [...new Set([...places, ...activities])];
  const tripDays = useMemo(() => calcDays(arrival, departure), [arrival, departure]);

  // planner_started — первое осмысленное действие в анкете, один раз за сессию
  // компонента (стратегия 14.08). Приход с плиткой намерения (?mood=...) — тоже
  // старт: плитки на главной и есть быстрый старт формы. Просто открыть пустую
  // страницу — ещё не старт: это уже пишет page_views.
  const plannerStartedRef = useRef(false);
  useEffect(() => {
    if (plannerStartedRef.current) return;
    if (places.length === 0 && activities.length === 0 && !arrival && !departure) return;
    plannerStartedRef.current = true;
    funnelBeacon('planner_started');
  }, [places, activities, arrival, departure]);

  // Нижняя панель шагов говорит, сколько места занимает: глобальная кнопка
  // «Подобрать тур» поднимается над ней, а не ложится на «Дальше».
  const stepBarShown = formOpen || !recommendation;
  useEffect(() => {
    const el = stepBarRef.current;
    const root = document.documentElement;
    if (!el) { root.style.removeProperty(PAGE_ACTION_BAR_VAR); return; }
    const publish = () => root.style.setProperty(PAGE_ACTION_BAR_VAR, `${el.offsetHeight}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(PAGE_ACTION_BAR_VAR);
    };
  }, [stepBarShown, mobileTab]);

  // Новый шаг и переход к результату начинаются сверху, а не с середины
  // прежнего экрана.
  useEffect(() => {
    if (planScrollRef.current) planScrollRef.current.scrollTop = 0;
  }, [step, formOpen]);

  // Editing day info for banner
  const editingDayInfo = useMemo(() => {
    if (editingDayId === null) return null;
    const idx = days.findIndex(d => d.day === editingDayId);
    if (idx < 0) return null;
    return { idx, title: days[idx].title };
  }, [editingDayId, days]);

  // Transport helpers
  const getTransport = useCallback((day: DayPlan): TransportType =>
    transportByDay[day.day] ?? day.defaultTransport, [transportByDay]);
  const setTransport = useCallback((dayNum: number, t: TransportType) =>
    setTransportByDay(prev => ({ ...prev, [dayNum]: t })), []);

  // Load top tour per activity type when days change
  useEffect(() => {
    const uniqueActivities = [...new Set(days.map(d => d.activityType))].filter(
      at => !loadedActivitiesRef.current.has(at)
    );
    if (uniqueActivities.length === 0) return;
    uniqueActivities.forEach(at => loadedActivitiesRef.current.add(at));
    void Promise.all(uniqueActivities.map(async (at) => {
      try {
        // Find the zone of the first day with this activity
        const dayWithActivity = days.find(d => d.activityType === at);
        const zone = dayWithActivity?.zone ?? '';
        const params = new URLSearchParams({ activity_type: at, limit: '1' });
        if (zone) params.set('zone', zone);
        const res = await fetch(`/api/planner/tours-for-day?${params.toString()}`);
        const data: { success: boolean; tours?: TourPreview[] } = await res.json();
        if (data.success && data.tours && data.tours.length > 0) {
          setToursPerActivity(prev => ({ ...prev, [at]: data.tours![0] }));
        }
      } catch { /* silent -- tours are optional */ }
    }));
  }, [days]);

  // Toggle edit mode on a day
  const toggleEditDay = useCallback((dayId: number) => {
    setEditingDayId(prev => prev === dayId ? null : dayId);
    setSelectedRoute(null);
  }, []);

  // Save / update trip in DB (requires auth)
  const saveTrip = useCallback(async () => {
    if (!initialUserId) {
      router.push(`/auth/login?from=/planner`);
      return;
    }
    if (days.length === 0) return;

    setSaveStatus('saving');
    try {
      const payload = {
        title: recommendation ? `Маршрут ${arrival || 'Камчатка'}` : 'Мой маршрут',
        arrivalDate: arrival || null,
        departureDate: departure || null,
        places,
        activities,
        days,
        transportByDay,
        flightArrival: flightArrival || null,
        flightDeparture: flightDeparture || null,
        flightArrivalTime: flightArrivalTime || null,
        flightDepartureTime: flightDepartureTime || null,
        needsAirportTransfer,
      };

      let res: Response;
      if (tripId) {
        res = await fetch(`/api/trips/${tripId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch('/api/trips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      const data: { success: boolean; data?: { id: string } } = await res.json();
      if (!data.success) throw new Error('save failed');

      if (!tripId && data.data?.id) setTripId(data.data.id);
      setSaveStatus('saved');
      // Сохранённый план — первое действие исполнения «активированной поездки».
      funnelBeacon('plan_saved', data.data?.id ?? tripId ?? undefined);
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [router, initialUserId, days, arrival, departure, places, activities, transportByDay, flightArrival, flightDeparture, flightArrivalTime, flightDepartureTime, needsAirportTransfer, recommendation, tripId]);

  const shareTrip = useCallback(async () => {
    if (!initialUserId) { router.push(`/auth/login?from=/planner`); return; }
    if (!tripId) { await saveTrip(); return; }
    setShareStatus('loading');
    try {
      const res = await fetch(`/api/trips/${tripId}/share`, { method: 'POST' });
      const data: { success: boolean; shareUrl?: string } = await res.json();
      if (!data.success || !data.shareUrl) throw new Error('share failed');
      setShareUrl(data.shareUrl);
      setShareStatus('done');
    } catch {
      setShareStatus('error');
      setTimeout(() => setShareStatus('idle'), 3000);
    }
  }, [router, initialUserId, tripId, saveTrip]);

  const handleShareCopy = useCallback(async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }, [shareUrl]);

  // Map: plan markers (numbered) + polyline + background route dots (colored by zone)
  const mapMarkers = useMemo((): MapMarker[] => {
    const result: MapMarker[] = [];

    // Zone → Yandex preset color mapping for suggestion dots
    const ZONE_DOT_PRESET: Record<string, string> = {
      avachinsky: 'islands#orangeDotIcon',
      eastern:    'islands#blueDotIcon',
      northern:   'islands#greenDotIcon',
      western:    'islands#violetDotIcon',
    };

    // Background route dots — colored by zone, bright in edit mode
    const editingDay = editingDayId !== null ? days.find(d => d.day === editingDayId) : null;

    bgRoutes.forEach(r => {
      const routeZone = r.zone ?? guessZone(r.lat, r.lng);
      const isNearEditZone = editingDay && routeZone === editingDay.zone;

      // In edit mode: matching zone bright, others gray
      // In overview: colored by zone
      let preset: string;
      if (editingDay) {
        preset = isNearEditZone
          ? (ZONE_DOT_PRESET[routeZone] ?? 'islands#orangeDotIcon')
          : 'islands#grayDotIcon';
      } else {
        preset = ZONE_DOT_PRESET[routeZone] ?? 'islands#grayDotIcon';
      }

      result.push({
        id: r.id,
        coords: [r.lat, r.lng],
        title: r.title,
        description: trunc(r.description, 80) || undefined,
        preset,
        suppressBalloon: true,
      });
    });

    if (days.length === 0) return result;

    // Unique zones for polyline
    const seen = new Set<string>();
    const zoneOrder: DayPlan[] = [];
    days.forEach(d => { if (!seen.has(d.zone)) { seen.add(d.zone); zoneOrder.push(d); } });

    // Plan day markers (numbered pins)
    days.forEach((d, i) => {
      const isEditing = d.day === editingDayId;
      result.push({
        id: `day_${d.day}`,
        coords: d.coords,
        title: `${i + 1}. ${d.title}`,
        description: ZONE_LABELS[d.zone] ?? d.zone,
        color: isEditing ? 'orange' : i === 0 ? 'red' : 'blue',
        suppressBalloon: true,
      });
    });

    // Линия между днями плана — ПОСТРОЕНИЕ, а не путь (lib/map/line-standard).
    // Она соединяет центры зон, между которыми бывает триста километров и
    // хребет. Сплошная оранжевая под словом «Маршрут» читалась как проход:
    // и вид, и подпись обещали то, чего никто не снимал.
    if (zoneOrder.length >= 2) {
      result.push({
        id: 'route_line',
        coords: zoneOrder[0].coords,
        title: CONNECTOR_TITLES.planOrder,
        geometry: { type: 'polyline', coordinates: zoneOrder.map(d => d.coords), ...connectorLine() },
      });
    }

    return result;
  }, [days, bgRoutes, editingDayId]);

  // Handle map marker click
  const handleMarkerClick = useCallback((id: string) => {
    // Click on day marker → scroll to day in panel + toggle edit
    if (id.startsWith('day_')) {
      const dayNum = Number(id.replace('day_', ''));
      if (!isNaN(dayNum)) {
        toggleEditDay(dayNum);
        // Scroll to day card
        const el = dayRefs.current.get(dayNum);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // On mobile, switch to plan tab
        setMobileTab('plan');
      }
      return;
    }
    if (id === 'route_line') return;
    // Click on suggestion route
    const route = bgRoutes.find(r => r.id === id);
    if (route) setSelectedRoute(route);
  }, [bgRoutes, toggleEditDay]);


  // Fetch background routes whenever interests change; defaults on mount
  useEffect(() => {
    const types = allInterests.length > 0
      ? [...new Set(allInterests)]
      : ['trekking', 'volcano', 'fishing'];
    let cancelled = false;

    setBgLoading(true);

    const fetches = types.map(actType =>
      fetch(`/api/routes?activity_type=${encodeURIComponent(actType)}&hasCoords=true&limit=30`)
        .then(r => r.json())
        .then(data => (data.success && Array.isArray(data.data) ? data.data as RoutePoint[] : [] as RoutePoint[]))
        .catch(() => [] as RoutePoint[])
    );

    Promise.all(fetches).then(results => {
      if (cancelled) return;
      const seen = new Set<string>();
      const deduped: RoutePoint[] = [];
      for (const batch of results) {
        for (const route of batch) {
          if (!seen.has(route.id)) { seen.add(route.id); deduped.push(route); }
        }
      }
      setBgRoutes(deduped);
      setBgLoading(false);
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places.join(','), activities.join(',')])

  // Clear edit mode when days change (e.g. day deleted)
  useEffect(() => {
    if (editingDayId !== null && !days.find(d => d.day === editingDayId)) {
      setEditingDayId(null);
    }
  }, [days, editingDayId]);

  function deleteDay(dayNum: number) {
    setDays(prev => prev.filter(d => d.day !== dayNum));
    setTransportByDay(prev => { const n = { ...prev }; delete n[dayNum]; return n; });
    setConfirmedDays(prev => { const n = new Set(prev); n.delete(dayNum); return n; });
    if (editingDayId === dayNum) setEditingDayId(null);
  }

  function confirmDay(dayNum: number) {
    setConfirmedDays(prev => new Set(prev).add(dayNum));
    if (editingDayId === dayNum) setEditingDayId(null);
  }

  function exportPDF() {
    const dayTypeLabels: Record<string, string> = {
      arrival: 'Прилёт', departure: 'Вылет', travel: 'Переезд',
      rest: 'Отдых', buffer: 'Резерв', activity: 'Активность',
    };

    const dateRange = arrival && departure ? `${arrival} — ${departure}` : '';
    const pb = recommendation?.priceBreakdown;

    const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"/>
<title>Маршрут по Камчатке${dateRange ? ` | ${dateRange}` : ''}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 40px; color: #1a1714; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #6b6560; font-size: 13px; margin-bottom: 24px; }
  .day { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; page-break-inside: avoid; }
  .day-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .day-num { width: 26px; height: 26px; border-radius: 50%; background: #D44A0C; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
  .day-title { font-weight: 600; font-size: 14px; flex: 1; }
  .day-badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: #f0f0f0; }
  .day-price { font-size: 12px; color: #D44A0C; font-weight: 600; white-space: nowrap; }
  .day-desc { font-size: 12px; color: #6b6560; margin-top: 4px; }
  .day-meta { font-size: 11px; color: #9a9590; margin-top: 4px; }
  .day-warn { font-size: 11px; color: #d29922; margin-top: 4px; padding: 4px 8px; background: #fef9ec; border-radius: 4px; }
  .confirmed { border-color: #3fb950; border-width: 2px; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 12px; color: #6b6560; }
  .price-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .price-total { display: flex; justify-content: space-between; font-size: 14px; font-weight: 600; margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e5e5; color: #D44A0C; }
  .warnings { margin-top: 16px; }
  .warning { padding: 6px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 6px; }
  .warning-critical { background: #fde8e8; color: #dc2626; }
  .warning-important { background: #fef9ec; color: #d29922; }
  .warning-info { background: #eef6ff; color: #2568b0; }
  @media print { body { margin: 20px; } }
</style></head><body>
<h1>Маршрут по Камчатке</h1>
<div class="subtitle">${dateRange ? `${dateRange} | ` : ''}${days.length} дней | ${adults} взрослых${childAges.length > 0 ? ` + дети: ${childAges.join(', ')} лет` : ''}</div>
${days.map((d, i) => `<div class="day${confirmedDays.has(d.day) ? ' confirmed' : ''}">
  <div class="day-header">
    <div class="day-num">${i + 1}</div>
    <div class="day-title">${d.title}</div>
    ${d.type !== 'activity' ? `<span class="day-badge">${dayTypeLabels[d.type] ?? d.type}</span>` : d.activityMode ? `<span class="day-badge">${ACTIVITY_MODE_LABEL[d.activityMode].label}</span>` : ''}
    <span class="day-price">от ${fmt(d.priceFrom)} ₽</span>
  </div>
  ${d.description ? `<div class="day-desc">${d.description}</div>` : ''}
  <div class="day-meta">${ZONE_LABELS[d.zone] ?? d.zone}${d.type === 'activity' ? ` | ${DIFFICULTY_LABEL[d.difficulty] ?? d.difficulty}` : ''}</div>
  ${d.dayWarnings.map(w => `<div class="day-warn">${w}</div>`).join('')}
</div>`).join('\n')}
${pb ? `<div class="footer">
  <div class="price-row"><span>Активности</span><span>${fmt(pb.activities[0])} — ${fmt(pb.activities[1])} ₽</span></div>
  <div class="price-row"><span>Размещение</span><span>${fmt(pb.accommodation[0])} — ${fmt(pb.accommodation[1])} ₽</span></div>
  <div class="price-row"><span>Транспорт</span><span>${fmt(pb.transport[0])} — ${fmt(pb.transport[1])} ₽</span></div>
  <div class="price-total"><span>Итого на человека</span><span>${fmt(pb.perPersonTotal[0])} — ${fmt(pb.perPersonTotal[1])} ₽</span></div>
  <div style="font-size:11px;color:#9a9590;margin-top:6px">Без авиабилетов Москва — Камчатка</div>
</div>` : ''}
${recommendation?.warnings && recommendation.warnings.length > 0 ? `<div class="warnings">
  ${recommendation.warnings.map(w => `<div class="warning warning-${w.severity}">${w.message}</div>`).join('')}
</div>` : ''}
<div style="margin-top:24px;font-size:11px;color:#9a9590;text-align:center">vedarai.ru — Камчатка с заботой</div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    // auto-print after a short delay for rendering
    setTimeout(() => { win.print(); }, 400);
  }

  function addDay() {
    if (days.length === 0) return;
    const newNum = Math.max(...days.map(d => d.day)) + 1;
    // Insert a free/rest day before the departure day
    const newDay: DayPlan = {
      day: newNum,
      type: 'activity',
      zone: 'avachinsky',
      title: 'Свободный день',
      description: 'Выберите активность или замените на карте',
      activityType: 'hot_spring',
      priceFrom: 0, priceTo: 5000,
      coords: [52.80, 158.80],
      defaultTransport: 'walking',
      allowedTransports: ['walking', 'jeep', 'helicopter'],
      difficulty: 'easy',
      childFriendly: true,
      minChildAge: 0,
      dayWarnings: [],
    };
    // Insert before departure day if exists
    const depIdx = days.findIndex(d => d.type === 'departure');
    if (depIdx >= 0) {
      setDays(prev => [...prev.slice(0, depIdx), newDay, ...prev.slice(depIdx)]);
    } else {
      setDays(prev => [...prev, newDay]);
    }
    setEditingDayId(newNum);
    setMobileTab('map');
  }

  function replaceDay(dayNum: number, route: RoutePoint) {
    setDays(prev => prev.map(d => d.day === dayNum ? routeToDayPlan(route, dayNum) : d));
    setTransportByDay(prev => { const n = { ...prev }; delete n[dayNum]; return n; });
    setSelectedRoute(null);
    setEditingDayId(null);
  }

  function addRouteAsDay(route: RoutePoint) {
    setDays(prev => {
      const newNum = prev.length > 0 ? Math.max(...prev.map(d => d.day)) + 1 : 1;
      return [...prev, routeToDayPlan(route, newNum)];
    });
    setSelectedRoute(null);
  }

  /**
   * Сборка маршрута. `over` — значения, только что разобранные из фразы:
   * состояние React к этому моменту ещё не обновилось, и без них сборка
   * видела бы прежние интересы и даты (так и было до 26.09 — setTimeout на
   * старом замыкании собирал пустой выбор).
   */
  async function getRecommendation(over: {
    interests?: string[]; arrival?: string; departure?: string;
    travelStyle?: TravelStyle; restDays?: number;
  } = {}) {
    const interests = over.interests ?? allInterests;
    const arr = over.arrival ?? arrival;
    const dep = over.departure ?? departure;
    const span = calcDays(arr, dep);
    const restCap = span != null && span > 0 ? Math.max(0, span - 3) : 0;
    const rest = Math.min(over.restDays ?? (restManual ? restDays : suggestRestDays(span)), restCap);
    if (interests.length === 0) { setError('Выберите место или активность'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/planner/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interests,
          arrivalDate: arr || undefined,
          departureDate: dep || undefined,
          flightArrivalTime: flightArrivalTime || undefined,
          flightDepartureTime: flightDepartureTime || undefined,
          adults,
          children: childAges,
          fitnessLevel,
          budgetTier,
          seasickness,
          riskMode,
          healthNotes: healthNotes.trim() || undefined,
          mobilityLevel,
          travelStyle: over.travelStyle ?? travelStyle,
          restDays: rest,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFormOpen(false);
        setStepError('');
        setRecommendation(data.data);
        setDays(data.data.days ?? []);
        setTransportByDay({});
        setConfirmedDays(new Set());
        setSelectedRoute(null);
        setEditingDayId(null);
        setShowItinerary(false);
        // Результат получен и показан — вторая ступень воронки. Дедуп на
        // приёмнике (60 минут), повторные пересборки план не задваивают.
        funnelBeacon('planner_result_viewed');
      } else {
        setError(data.error || 'Ошибка при получении рекомендации');
      }
    } catch { setError('Нет соединения. Попробуйте снова.'); }
    finally { setLoading(false); }
  }

  async function submitLead() {
    setContactError('');
    const name  = contactName.trim();
    const phone = contactPhone.trim();
    if (name.length < 2)   { setContactError('Введите имя'); return; }
    if (phone.length < 10) { setContactError('Введите телефон'); return; }
    if (!pdConsent)        { setContactError('Необходимо согласие на обработку персональных данных'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, phone,
          comment: contactComment.trim() || undefined,
          source_url: typeof window !== 'undefined' ? window.location.href : '/planner',
          source_data: {
            source: 'planner_page',
            interests: allInterests,
            arrival: arrival || undefined,
            departure: departure || undefined,
            flight_arrival: flightArrival || undefined,
            flight_departure: flightDeparture || undefined,
            flight_arrival_time: flightArrivalTime || undefined,
            flight_departure_time: flightDepartureTime || undefined,
            needs_airport_transfer: needsAirportTransfer || undefined,
            trip_days: tripDays ?? undefined,
            recommendation: recommendation?.zones,
            transport_choices: transportByDay,
            day_plan: days.map((d, i) => ({ day: i + 1, title: d.title, zone: d.zone, activity: d.activityType })),
          },
          pd_consent: true,
        }),
      });
      const data = await res.json();
      if (data.success) setDone(true);
      else setContactError(data.error ?? 'Ошибка');
    } catch { setContactError('Нет соединения'); }
    finally { setSubmitting(false); }
  }

  async function handleChatFill() {
    const text = chatInput.trim();
    if (!text) return;
    setChatLoading(true);
    try {
      const res = await fetch('/api/planner/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data: {
        success: boolean;
        places?: string[];
        activities?: string[];
        arrival?: string | null;
        departure?: string | null;
        auto_recommend?: boolean;
        travel_style?: TravelStyle | null;
        rest_days?: number | null;
        error?: string;
      } = await res.json();
      if (!data.success) {
        setChatNote(data.error ?? 'Не получилось разобрать описание — заполните шаги ниже.');
        return;
      }
      const nextPlaces = data.places && data.places.length > 0 ? data.places : places;
      const nextActivities = data.activities && data.activities.length > 0 ? data.activities : activities;
      setPlaces(nextPlaces);
      setActivities(nextActivities);
      if (data.arrival)   setArrival(data.arrival);
      if (data.departure) setDeparture(data.departure);
      if (data.travel_style) setTravelStyle(data.travel_style);
      if (typeof data.rest_days === 'number') { setRestDays(data.rest_days); setRestManual(true); }
      setChatInput('');
      const nextArrival = data.arrival || arrival;
      const nextDeparture = data.departure || departure;
      const hasDates = Boolean(nextArrival && nextDeparture && nextDeparture > nextArrival);
      if (data.auto_recommend && hasDates) {
        setChatNote('');
        void getRecommendation({
          interests: [...new Set([...nextPlaces, ...nextActivities])],
          arrival: nextArrival,
          departure: nextDeparture,
          travelStyle: data.travel_style ?? undefined,
          restDays: typeof data.rest_days === 'number' ? data.rest_days : undefined,
        });
      } else if (!hasDates) {
        // Даты не названы — их не выдумываем: остаёмся на шаге «Когда».
        setChatNote('Поняли, что вам интересно. Осталось выбрать даты прилёта и отъезда.');
        setStep(1);
      } else {
        // Разобрали, но собирать рано — показываем заполненный выбор.
        setChatNote('');
        setStep(4);
      }
    } catch {
      setChatNote('Нет соединения — заполните шаги вручную.');
    }
    finally { setChatLoading(false); }
  }

  // ── Plan panel content ─────────────────────────────────────────────────────

  // Заявка на подробное предложение — одна форма для результата и для
  // «не знаю, что выбрать» на шаге 4 (раньше там кнопка открывала форму,
  // которая рисовалась только под готовым маршрутом, то есть нигде).
  const contactBlock = (
    <>
    {!showContact ? (
      <button onClick={() => setShowContact(true)} className="w-full ds-btn ds-btn-primary py-2.5 font-semibold">
        Запросить подробное предложение
      </button>
    ) : (
      <div className="space-y-3 pt-1 border-t border-[var(--border)]">
        <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Контакты</p>
        <input type="text" value={contactName} onChange={e => setContactName(e.target.value)}
          placeholder="Ваше имя" className="ds-input w-full text-sm" />
        <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)}
          placeholder="+7 900 000-00-00" className="ds-input w-full text-sm" />
        <textarea value={contactComment} onChange={e => setContactComment(e.target.value)}
          placeholder="Пожелания, вопросы, особые требования..."
          rows={3}
          className="ds-input w-full text-sm resize-none" />
        {contactError && (
          <div className="flex items-center gap-2 p-2 bg-[var(--danger)]/10 rounded-lg">
            <AlertTriangle className="w-3.5 h-3.5 text-[var(--danger)] shrink-0" />
            <p className="text-xs text-[var(--danger)]">{contactError}</p>
          </div>
        )}
        <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-planner" />
        <button onClick={submitLead} disabled={submitting || !pdConsent}
          className="w-full ds-btn ds-btn-primary py-2.5 font-semibold disabled:opacity-50">
          {submitting ? 'Отправляем...' : 'Отправить заявку'}
        </button>
      </div>
    )}
    </>
  );

  // ── Анкета: четыре коротких шага (решение владельца 26.09) ─────────────────
  //
  // На телефоне — один шаг на экран, прогресс «Шаг N из 4» и нижняя панель
  // «Назад» / «Дальше»; последний шаг — «Собрать маршрут». На компьютере те
  // же шаги в колонке справа: компонент один. Порядок шагов держит сторож
  // tests/unit/planner-steps.test.ts.

  /** Потолок дней отдыха на форме — то же правило, что у движка (fitRestDays). */
  const maxRestDays = tripDays != null && tripDays > 0 ? Math.max(0, tripDays - 3) : 0;
  const restSuggested = suggestRestDays(tripDays);
  const restDaysToSend = Math.min(restManual ? restDays : restSuggested, maxRestDays);

  function goNext() {
    setStepError('');
    if (step === 1) {
      // Без обеих дат движок не может разложить поездку по дням (getTripDays
      // даёт 0) — пускать дальше значило бы собрать пустой план.
      if (!arrival || !departure) {
        setStepError('Укажите даты прилёта и отъезда: без них маршрут по дням не собрать.');
        return;
      }
      if (departure <= arrival) {
        setStepError('Дата отъезда должна быть позже даты прилёта.');
        return;
      }
    }
    if (step < 4) { setStep((s) => (s + 1) as PlannerStep); return; }
    buildRoute();
  }

  function goBack() {
    setStepError('');
    if (step > 1) setStep((s) => (s - 1) as PlannerStep);
  }

  function buildRoute() {
    if (allInterests.length === 0) {
      setStepError('Выберите хотя бы одно место или занятие.');
      return;
    }
    if (!arrival || !departure || departure <= arrival) {
      setStep(1);
      setStepError('Укажите даты прилёта и отъезда: без них маршрут по дням не собрать.');
      return;
    }
    void getRecommendation();
  }

  const stepHeader = (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-[var(--text-secondary)]" aria-live="polite">
          Шаг {step} из 4
        </p>
        {recommendation && (
          <button type="button" onClick={() => { setFormOpen(false); setStepError(''); }}
            className="text-xs font-medium text-[var(--ocean)] min-h-[44px] px-1 transition-colors duration-200 motion-reduce:transition-none">
            К маршруту
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1.5" aria-hidden="true">
        {PLANNER_STEPS.map((s) => (
          <span key={s.n}
            className={`h-1 rounded-full transition-colors duration-200 motion-reduce:transition-none ${
              s.n <= step ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'
            }`} />
        ))}
      </div>
      <h1 className="font-playfair text-3xl font-bold leading-tight text-[var(--text-primary)] text-balance">
        {PLANNER_STEPS[step - 1].title}
      </h1>
      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{PLANNER_STEPS[step - 1].lead}</p>
    </div>
  );

  const stepWhen = (
    <div className="space-y-6" data-step="when">
      {/* Быстрый путь — сверху, как было: одна фраза заполняет все шаги. */}
      <div className="space-y-2">
        <label htmlFor="planner-quick" className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Опишите поездку одной фразой
        </label>
        <div className="flex gap-2">
          <input
            id="planner-quick"
            type="text"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !chatLoading) void handleChatFill(); }}
            placeholder="вулканы и рыбалка, 7 дней в июле, сами"
            maxLength={500}
            className="ds-input flex-1 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleChatFill()}
            disabled={chatLoading || !chatInput.trim()}
            aria-label="Разобрать описание"
            className="ds-btn ds-btn-primary min-w-[44px] px-3 disabled:opacity-50"
          >
            {chatLoading ? <Loader className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">Заполним шаги за вас — всё можно поправить.</p>
        {chatNote && <p className="text-xs text-[var(--text-secondary)]" role="status">{chatNote}</p>}
      </div>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="flex-1 h-px bg-[var(--border)]" />
        <span className="text-xs text-[var(--text-muted)]">или по шагам</span>
        <span className="flex-1 h-px bg-[var(--border)]" />
      </div>

      <fieldset className="space-y-3">
        <legend className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] mb-2">
          <PlaneLanding className="w-4 h-4 text-[var(--ocean)]" />Прилёт
        </legend>
        <div className="grid grid-cols-[1.4fr_1fr] gap-2">
          <input type="date" aria-label="Дата прилёта" value={arrival} min={today()} max={maxDate()}
            onChange={e => { setStepError(''); setArrival(e.target.value); if (departure && departure <= e.target.value) setDeparture(''); }}
            className="ds-input w-full text-sm" />
          <input type="time" aria-label="Время прилёта" value={flightArrivalTime}
            onChange={e => setFlightArrivalTime(e.target.value)}
            className="ds-input w-full text-sm" />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] mb-2">
          <PlaneTakeoff className="w-4 h-4 text-[var(--ocean)]" />Отъезд
        </legend>
        <div className="grid grid-cols-[1.4fr_1fr] gap-2">
          <input type="date" aria-label="Дата отъезда" value={departure} min={arrival || today()} max={maxDate()}
            onChange={e => { setStepError(''); setDeparture(e.target.value); }}
            className="ds-input w-full text-sm" />
          <input type="time" aria-label="Время вылета" value={flightDepartureTime}
            onChange={e => setFlightDepartureTime(e.target.value)}
            className="ds-input w-full text-sm" />
        </div>
      </fieldset>

      <p className="text-sm font-medium flex items-center gap-2 min-h-[1.5rem]" aria-live="polite">
        {tripDays != null && tripDays > 0 ? (
          <>
            <CalendarDays className="w-4 h-4 text-[var(--success)]" />
            <span className="text-[var(--text-primary)]">
              {tripDays} {pluralDaysRu(tripDays)} на Камчатке
            </span>
          </>
        ) : (
          <span className="text-[var(--text-muted)]">Выберите обе даты — посчитаем дни</span>
        )}
      </p>

      <details className="group rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <summary className="flex items-center justify-between gap-2 px-4 min-h-[44px] cursor-pointer text-sm text-[var(--text-secondary)] list-none">
          Номера рейсов и встреча в аэропорту
          <ChevronDown className="w-4 h-4 transition-transform duration-200 motion-reduce:transition-none group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <input type="text" aria-label="Рейс прилёта" value={flightArrival}
              onChange={e => setFlightArrival(e.target.value.toUpperCase())}
              placeholder="Рейс прилёта" maxLength={20}
              className="ds-input w-full text-sm" />
            <input type="text" aria-label="Рейс вылета" value={flightDeparture}
              onChange={e => setFlightDeparture(e.target.value.toUpperCase())}
              placeholder="Рейс вылета" maxLength={20}
              className="ds-input w-full text-sm" />
          </div>
          <label className="flex items-center gap-3 min-h-[44px] cursor-pointer select-none">
            <input type="checkbox" checked={needsAirportTransfer}
              onChange={e => setNeedsAirportTransfer(e.target.checked)}
              className="w-5 h-5 rounded accent-[var(--accent)]" />
            <span className="text-sm text-[var(--text-secondary)]">
              Встреча в аэропорту и трансфер (~2 500 ₽ в одну сторону)
            </span>
          </label>
        </div>
      </details>
    </div>
  );

  const stepWho = (
    <div className="space-y-6" data-step="who">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
            <Users className="w-4 h-4 text-[var(--ocean)]" />Взрослых
          </span>
          <select value={adults} onChange={e => setAdults(Number(e.target.value))} className="ds-input w-full text-sm">
            {[1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
            <Baby className="w-4 h-4 text-[var(--ocean)]" />Детей
          </span>
          <select value={childAges.length} onChange={e => {
            const count = Number(e.target.value);
            setChildAges(prev => {
              if (count > prev.length) return [...prev, ...Array(count - prev.length).fill(10) as number[]];
              return prev.slice(0, count);
            });
          }} className="ds-input w-full text-sm">
            {[0,1,2,3,4].map(n => <option key={n} value={n}>{n === 0 ? 'Нет' : n}</option>)}
          </select>
        </label>
      </div>
      {childAges.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm text-[var(--text-secondary)]">Возраст детей</p>
          <div className="flex flex-wrap gap-2">
            {childAges.map((age, i) => (
              <select key={i} aria-label={`Возраст ребёнка ${i + 1}`} value={age} onChange={e => {
                const newAge = Number(e.target.value);
                setChildAges(prev => prev.map((a, j) => j === i ? newAge : a));
              }} className="ds-input text-sm w-24">
                {Array.from({ length: 18 }, (_, k) => <option key={k} value={k}>{k === 0 ? 'до года' : `${k} ${k === 1 ? 'год' : k < 5 ? 'года' : 'лет'}`}</option>)}
              </select>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Dumbbell className="w-4 h-4 text-[var(--ocean)]" />Подготовка
        </p>
        <Segmented
          label="Подготовка"
          value={fitnessLevel}
          onChange={setFitnessLevel}
          options={[
            { value: 'beginner', label: 'Первый раз' },
            { value: 'moderate', label: 'Хожу в походы' },
            { value: 'active', label: 'Опытный' },
          ]}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Accessibility className="w-4 h-4 text-[var(--ocean)]" />Подвижность
        </p>
        <Segmented
          label="Подвижность"
          value={mobilityLevel}
          onChange={setMobilityLevel}
          options={[
            { value: 'full', label: 'Полная' },
            { value: 'limited', label: 'Ограниченная' },
            { value: 'wheelchair', label: 'На коляске' },
          ]}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="planner-health" className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <HeartPulse className="w-4 h-4 text-[var(--ocean)]" />Ограничения по здоровью
          <span className="text-xs font-normal text-[var(--text-muted)]">необязательно</span>
        </label>
        <textarea
          id="planner-health"
          value={healthNotes}
          onChange={e => setHealthNotes(e.target.value.slice(0, HEALTH_NOTES_MAX))}
          placeholder="Например: колено, астма"
          rows={2}
          maxLength={HEALTH_NOTES_MAX}
          className="ds-input w-full text-sm resize-none"
        />
        <p className="text-xs text-[var(--text-secondary)] flex items-start gap-1.5">
          <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Только для подбора маршрута: не сохраняем и не отправляем в нейросети.
        </p>
      </div>

      <label className="flex items-center gap-3 min-h-[44px] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={seasickness}
          onChange={e => setSeasickness(e.target.checked)}
          className="w-5 h-5 rounded accent-[var(--accent)]"
        />
        <span className="text-sm text-[var(--text-secondary)]">
          Укачивает на воде — обойтись без катеров, где можно
        </span>
      </label>
    </div>
  );

  const stepHow = (
    <div className="space-y-6" data-step="how">
      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Compass className="w-4 h-4 text-[var(--ocean)]" />Как ехать
        </p>
        <div role="radiogroup" aria-label="Как ехать" className="grid gap-2">
          {TRAVEL_STYLES.map((s) => {
            const active = travelStyle === s;
            return (
              <button key={s} type="button" role="radio" aria-checked={active}
                onClick={() => setTravelStyle(s)}
                className={`text-left rounded-lg border px-4 py-3 min-h-[44px] transition-colors duration-200 motion-reduce:transition-none ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-muted)]'
                    : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-strong)]'
                }`}>
                <span className={`block text-sm font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                  {TRAVEL_STYLE_LABEL[s].label}
                </span>
                <span className="block text-xs text-[var(--text-secondary)] mt-0.5 leading-snug">
                  {TRAVEL_STYLE_LABEL[s].hint}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Coffee className="w-4 h-4 text-[var(--ocean)]" />Дни отдыха
        </p>
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Меньше дней отдыха"
            onClick={() => { setRestManual(true); setRestDays(Math.max(0, restDaysToSend - 1)); }}
            disabled={restDaysToSend <= 0}
            className="ds-btn ds-btn-secondary w-11 h-11 p-0 disabled:opacity-40">
            <Minus className="w-4 h-4" />
          </button>
          <output className="min-w-[3ch] text-center font-playfair text-2xl font-bold text-[var(--text-primary)]" aria-live="polite">
            {restDaysToSend}
          </output>
          <button type="button" aria-label="Больше дней отдыха"
            onClick={() => { setRestManual(true); setRestDays(Math.min(maxRestDays, restDaysToSend + 1)); }}
            disabled={restDaysToSend >= maxRestDays}
            className="ds-btn ds-btn-secondary w-11 h-11 p-0 disabled:opacity-40">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          {maxRestDays > 0
            ? `${restManual ? 'Поставили вы' : `Посчитали по датам: день отдыха на каждые ${REST_EVERY_DAYS} дней поездки`}. До ${maxRestDays} при ${tripDays} ${pluralDaysRu(tripDays ?? 0)}. Резерв на нелётную погоду добавим сами, если он нужен.`
            : 'Поездка короткая: место нужно прилёту, вылету и хотя бы одному дню на маршруте.'}
        </p>
        {restManual && maxRestDays > 0 && restDaysToSend !== Math.min(restSuggested, maxRestDays) && (
          <button type="button" onClick={() => setRestManual(false)}
            className="text-xs text-[var(--ocean)] underline underline-offset-2 min-h-[44px]">
            Вернуть по датам ({Math.min(restSuggested, maxRestDays)})
          </button>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
          <Wallet className="w-4 h-4 text-[var(--ocean)]" />Бюджет
        </p>
        <Segmented
          label="Бюджет"
          value={budgetTier}
          onChange={setBudgetTier}
          options={[
            { value: 'economy', label: 'Эконом' },
            { value: 'comfort', label: 'Комфорт' },
            { value: 'premium', label: 'Премиум' },
          ]}
        />
      </div>

      {/* Risk Mode — как было (решение владельца 26.09: блок не переименовывать) */}
      <div className="space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] flex items-center gap-1">
          <ShieldAlert className="w-3 h-3" />Режим маршрутов
        </p>
        <div className="grid grid-cols-3 gap-1">
          {([
            { value: 'safe_only', label: 'Безопасный', desc: 'Только проверенные, без alerts' },
            { value: 'adventure', label: 'Приключение', desc: 'Все маршруты включая опасные' },
            { value: 'available', label: 'Свободные', desc: 'Все что есть по наличию мест' },
          ] as const).map(m => (
            <button
              key={m.value}
              type="button"
              onClick={() => setRiskMode(m.value)}
              title={m.desc}
              className={`px-2 py-2 min-h-[44px] rounded text-xs font-medium transition-all border ${
                riskMode === m.value
                  ? m.value === 'adventure'
                    ? 'bg-[color-mix(in_srgb,var(--warning)_16%,var(--bg-card))] border-[var(--warning)] text-[var(--warning)]'
                    : 'bg-[color-mix(in_srgb,var(--accent)_16%,var(--bg-card))] border-[var(--accent)] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {riskMode === 'adventure' && (
          <p className="text-[10px] text-[var(--warning)] flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            Включены маршруты с предупреждениями МЧС. Требуется опыт и снаряжение.
          </p>
        )}
      </div>
    </div>
  );

  const stepWhat = (
    <div className="space-y-6" data-step="what">
      <SelectGroup title="Места" items={PLACES} selected={places}
        onToggle={id => setPlaces(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])} />
      <SelectGroup title="Активности" items={ACTIVITIES} selected={activities}
        onToggle={id => setActivities(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])} />
      {allInterests.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-2">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Не знаете, что выбрать?</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            Оставьте заявку — подберём готовый пакет под ваши даты и бюджет: размещение, трансфер и программу.
          </p>
          {contactBlock}
        </div>
      )}
    </div>
  );

  const STEP_VIEWS: Record<PlannerStep, React.ReactNode> = { 1: stepWhen, 2: stepWho, 3: stepHow, 4: stepWhat };

  const stepsView = (
    <div className="px-4 pt-5 space-y-6" style={{ paddingBottom: CONTENT_BOTTOM_CLEARANCE }}>
      {stepHeader}
      {STEP_VIEWS[step]}
    </div>
  );

  /** Короткая сводка анкеты над результатом: каждая строка открывает свой шаг. */
  const summaryRows: Array<{ n: PlannerStep; label: string; value: string }> = [
    { n: 1, label: 'Когда', value: tripDays ? `${shortDate(arrival)} — ${shortDate(departure)}, ${tripDays} ${pluralDaysRu(tripDays)}` : 'даты не выбраны' },
    { n: 2, label: 'Кто едет', value: `${adults} взр.${childAges.length > 0 ? `, детей ${childAges.length}` : ''}` },
    { n: 3, label: 'Как', value: `${TRAVEL_STYLE_LABEL[travelStyle].label}${restDaysToSend > 0 ? `, отдых ${restDaysToSend}` : ''}` },
    { n: 4, label: 'Что', value: allInterests.map((i) => ACTIVITY_LABEL[i] ?? i).join(', ') || 'не выбрано' },
  ];

  const summaryCard = (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)]">
      {summaryRows.map((r) => (
        <button key={r.n} type="button" onClick={() => { setStep(r.n); setFormOpen(true); }}
          className="w-full flex items-center gap-3 px-4 min-h-[44px] py-2 text-left transition-colors duration-200 motion-reduce:transition-none hover:bg-[var(--bg-hover)]">
          <span className="w-20 shrink-0 text-xs text-[var(--text-muted)]">{r.label}</span>
          <span className="flex-1 min-w-0 text-sm text-[var(--text-primary)] truncate">{r.value}</span>
          <Pencil className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
        </button>
      ))}
    </div>
  );

  /** Что попросили стилем и отдыхом — и что из этого вышло (от движка). */
  const preferenceNotesBlock = recommendation?.preferences && recommendation.preferences.notes.length > 0 ? (
    <section className="space-y-2" aria-label="Ваши пожелания">
      <p className="text-sm font-medium text-[var(--text-primary)]">Ваши пожелания</p>
      <ul className="space-y-1.5">
        {recommendation.preferences.notes.map((n, i) => (
          <li key={`${n.topic}-${i}`}
            className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-snug text-[var(--text-primary)]"
            style={{
              background: `color-mix(in srgb, var(${n.status === 'honoured' ? '--success' : '--warning'}) 10%, var(--bg-card))`,
              borderColor: `color-mix(in srgb, var(${n.status === 'honoured' ? '--success' : '--warning'}) 35%, transparent)`,
            }}>
            {n.status === 'honoured'
              ? <Check className="w-4 h-4 mt-0.5 shrink-0 text-[var(--success)]" />
              : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" />}
            <span>{n.message}</span>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  const stepBar = (
    <div ref={stepBarRef}
      className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-card)] px-4 pt-3"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}>
      {stepError && (
        <p role="alert" className="mb-2 text-sm text-[var(--danger)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{stepError}
        </p>
      )}
      {error && !stepError && (
        <p role="alert" className="mb-2 text-sm text-[var(--danger)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={goBack} disabled={step === 1}
          className="ds-btn ds-btn-secondary px-4 disabled:opacity-40">
          <ArrowLeft className="w-4 h-4" />Назад
        </button>
        <button type="button" onClick={goNext} disabled={loading}
          className="ds-btn ds-btn-primary flex-1 font-semibold disabled:opacity-60">
          {step < 4 ? (
            <>Дальше<ArrowRight className="w-4 h-4" /></>
          ) : loading ? (
            <><Loader className="w-4 h-4 animate-spin motion-reduce:animate-none" />Собираем маршрут</>
          ) : (
            <><Sparkles className="w-4 h-4" />Собрать маршрут</>
          )}
        </button>
      </div>
    </div>
  );

  const resultsView = (
    <div className="p-4 space-y-4" style={{ paddingBottom: CONTENT_BOTTOM_CLEARANCE }}>
      {summaryCard}
      {preferenceNotesBlock}

      {/* Results */}
      {recommendation && (
        <>
          {recommendation.warnings && recommendation.warnings.length > 0 && (
            <div className="space-y-1.5">
              {recommendation.warnings.filter(w => w.severity === 'critical').map((w, i) => (
                <div key={`crit-${i}`} className="flex items-start gap-2 p-3 bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg">
                  <ShieldAlert className="w-4 h-4 text-[var(--danger)] shrink-0 mt-0.5" />
                  <p className="text-xs text-[var(--danger)]">
                    {w.type === 'mchs' && <span className="font-bold mr-1">МЧС</span>}
                    {w.message}
                  </p>
                </div>
              ))}
              {recommendation.warnings.filter(w => w.severity === 'important').map((w, i) => (
                <div key={`imp-${i}`} className="flex items-start gap-2 p-3 bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
                  <p className="text-xs text-[var(--warning)]">
                    {w.type === 'mchs' && <span className="font-bold mr-1">МЧС</span>}
                    {w.type === 'crowd' && <span className="font-bold mr-1">Загрузка</span>}
                    {w.message}
                  </p>
                </div>
              ))}
              {recommendation.warnings.filter(w => w.severity === 'info').map((w, i) => (
                <div key={`info-${i}`} className="flex items-start gap-2 p-3 bg-[var(--ocean)]/10 border border-[var(--ocean)]/20 rounded-lg">
                  <Info className="w-4 h-4 text-[var(--ocean)] shrink-0 mt-0.5" />
                  <p className="text-xs text-[var(--ocean)]">
                    {w.type === 'crowd' && <span className="font-bold mr-1">Загрузка</span>}
                    {w.message}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Zones */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Зоны</p>
            <div className="flex flex-wrap gap-1.5">
              {recommendation.zones.map(z => (
                <div key={z.zone} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--bg-hover)] rounded-full border border-[var(--border)]">
                  <div className="w-2 h-2 rounded-full" style={{ background: ZONE_COLORS[z.zone] ?? 'var(--accent)' }} />
                  <span className="text-xs font-medium text-[var(--text-primary)]">{ZONE_LABELS[z.zone] ?? z.zone}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{z.score}%</span>
                  {z.crowdScore !== undefined && z.crowdScore > 50 && (
                    <span className={`text-[10px] font-medium ${z.crowdScore > 70 ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
                      {z.crowdScore > 70 ? 'загружено' : 'умеренно'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Days */}
          {days.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  {days.length} {days.length === 1 ? 'день' : days.length < 5 ? 'дня' : 'дней'}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {editingDayId !== null ? 'кликните карту для замены' : 'кликните день для редактирования'}
                </p>
              </div>

              <Reorder.Group
                axis="y"
                values={days}
                onReorder={(newDays) => {
                  setDays(newDays);
                  setValidation(null);
                  if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
                  if (newDays.length >= 2) {
                    validationTimerRef.current = setTimeout(() => {
                      void fetch('/api/planner/validate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          days: newDays.map(d => ({
                            day: d.day,
                            zone: d.zone,
                            title: d.title,
                            activityType: d.activityType,
                            defaultTransport: d.defaultTransport,
                          })),
                          arrivalDate: arrival || undefined,
                          fitnessLevel,
                          seasickness,
                          children: childAges.length > 0 ? childAges : undefined,
                        }),
                      }).then(r => r.json()).then((data: { success: boolean; valid?: boolean; message?: string; issues?: Array<{ type: string; severity: string; message: string; day?: number }> }) => {
                        if (data.success && data.message) {
                          const issueText = data.issues && data.issues.length > 0
                            ? `${data.message}\n${data.issues.map(i => `- ${i.message}`).join('\n')}`
                            : data.message;
                          setValidation({ valid: data.valid ?? true, message: issueText });
                        }
                      }).catch(() => { /* silent */ });
                    }, 800);
                  }
                }}
                className="space-y-1.5"
              >
                {days.map((day, idx) => (
                  <DayCard
                    key={day.day}
                    day={day}
                    idx={idx}
                    isEditing={day.day === editingDayId}
                    isConfirmed={confirmedDays.has(day.day)}
                    transport={getTransport(day)}
                    topTour={toursPerActivity[day.activityType]}
                    flightBadge={
                      days.length >= 3 && idx === 0
                        ? (flightArrival || 'Прилёт')
                        : days.length >= 3 && idx === days.length - 1
                          ? (flightDeparture || 'Вылет')
                          : undefined
                    }
                    isLocked={days.length >= 3 && (idx === 0 || idx === days.length - 1)}
                    onToggleEdit={toggleEditDay}
                    onTransportChange={setTransport}
                    onShowPartners={(at) => setPartnersModal({ activityType: at })}
                    onDelete={deleteDay}
                    onShowMap={() => setMobileTab('map')}
                    onConfirm={confirmDay}
                    onRef={(el) => {
                      if (el) dayRefs.current.set(day.day, el as HTMLElement);
                      else dayRefs.current.delete(day.day);
                    }}
                  />
                ))}
              </Reorder.Group>

              {/* AI route validation result */}
              {validation && (
                <div className={`px-3 py-2 rounded-lg text-xs font-medium mt-1.5 ${
                  validation.valid
                    ? 'bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20'
                    : 'bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20'
                }`}>
                  <div className="flex items-center gap-2">
                    {validation.valid
                      ? <Check className="w-3.5 h-3.5 shrink-0" />
                      : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{validation.message.split('\n')[0]}</span>
                  </div>
                  {validation.message.includes('\n') && (
                    <ul className="mt-1.5 ml-5 space-y-0.5 text-[var(--text-secondary)]">
                      {validation.message.split('\n').slice(1).filter(Boolean).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Add day */}
              <button type="button" onClick={addDay}
                className="mt-1.5 w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-[var(--border)] text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors">
                <Plus className="w-3.5 h-3.5" />
                Добавить день
              </button>

              {/* Price breakdown */}
              {recommendation.priceBreakdown && (
                <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-[var(--text-muted)]">Активности</span>
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      {fmt(recommendation.priceBreakdown.activities[0])} — {fmt(recommendation.priceBreakdown.activities[1])} ₽
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-[var(--text-muted)]">Размещение</span>
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      {fmt(recommendation.priceBreakdown.accommodation[0])} — {fmt(recommendation.priceBreakdown.accommodation[1])} ₽
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-[var(--text-muted)]">Транспорт</span>
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      {fmt(recommendation.priceBreakdown.transport[0])} — {fmt(recommendation.priceBreakdown.transport[1])} ₽
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-1 pt-1 border-t border-[var(--border)]">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Итого на человека</span>
                    <span className="text-sm font-semibold text-[var(--accent)]">
                      {fmt(recommendation.priceBreakdown.perPersonTotal[0])} — {fmt(recommendation.priceBreakdown.perPersonTotal[1])} ₽
                    </span>
                  </div>
                  <p className="text-[9px] text-[var(--text-muted)] px-1">Без авиабилетов Москва — Камчатка (25 000-60 000 ₽)</p>
                </div>
              )}
            </div>
          )}

          {/* AI itinerary */}
          {recommendation.itinerary && (
            <div>
              <button onClick={() => setShowItinerary(v => !v)}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
                {showItinerary ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {showItinerary ? 'Скрыть программу' : 'Подробная программа'}
              </button>
              {showItinerary && (
                <div className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed space-y-1.5 p-3 bg-[var(--bg-hover)] rounded-lg">
                  {recommendation.itinerary.split('\n').filter(l => l.trim()).map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Confirmation progress + PDF export */}
          {days.length > 0 && (
            <div className="space-y-2">
              {confirmedDays.size > 0 && (
                <div className="flex items-center gap-2 px-1">
                  <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                    <div className="h-full bg-[var(--success)] rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((confirmedDays.size / days.length) * 100)}%` }} />
                  </div>
                  <span className="text-[10px] font-medium text-[var(--text-muted)] shrink-0">
                    {confirmedDays.size}/{days.length}
                  </span>
                </div>
              )}
              {confirmedDays.size === days.length && days.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/20">
                  <CheckCircle className="w-4 h-4 text-[var(--success)] shrink-0" />
                  <span className="text-xs font-medium text-[var(--success)]">Все дни подтверждены. Маршрут готов!</span>
                </div>
              )}
              <button type="button" onClick={exportPDF}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors bg-[var(--bg-card)]">
                <Download className="w-4 h-4" />
                Скачать PDF маршрута
              </button>
            </div>
          )}

          {/* Save trip */}
          {days.length > 0 && (
            <div className="flex gap-2">
              <button
                onClick={saveTrip}
                disabled={saveStatus === 'saving'}
                className={`flex-1 ds-btn py-2.5 font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50 ${
                  saveStatus === 'saved'
                    ? 'bg-[var(--success)] border-[var(--success)] text-white'
                    : saveStatus === 'error'
                    ? 'bg-[var(--danger)] border-[var(--danger)] text-white'
                    : 'ds-btn-secondary'
                }`}
              >
                {saveStatus === 'saving' && <Loader className="w-4 h-4 animate-spin" />}
                {saveStatus === 'saved' && <BookmarkCheck className="w-4 h-4" />}
                {saveStatus === 'error' && <AlertTriangle className="w-4 h-4" />}
                {saveStatus === 'idle' && <Save className="w-4 h-4" />}
                {saveStatus === 'saving' ? 'Сохраняем...'
                  : saveStatus === 'saved' ? 'Сохранено'
                  : saveStatus === 'error' ? 'Ошибка'
                  : !initialUserId ? 'Войти и сохранить'
                  : tripId ? 'Обновить маршрут'
                  : 'Сохранить маршрут'}
              </button>
              <button
                onClick={shareTrip}
                disabled={shareStatus === 'loading'}
                className="ds-btn ds-btn-secondary px-3 py-2.5 flex items-center justify-center"
                title="Поделиться маршрутом"
              >
                {shareStatus === 'loading' ? <Loader className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              </button>
              {tripId && (
                <a
                  href={`/hub/tourist/trips/${tripId}`}
                  className="ds-btn ds-btn-secondary px-3 py-2.5 flex items-center justify-center"
                  title="Открыть сохранённый маршрут"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          )}

          {shareStatus === 'done' && shareUrl && (
            <div className="rounded-lg p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Поделиться</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={handleShareCopy}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  {shareCopied ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> : <Copy className="w-3.5 h-3.5" />}
                  {shareCopied ? 'Скопировано' : 'Копировать ссылку'}
                </button>
                <a href={`https://t.me/share/url?url=${encodeURIComponent(withReferral(shareUrl, myReferralCode))}&text=${encodeURIComponent(`${(recommendation as { title?: string } | null)?.title ?? 'Маршрут'} — ${days.length} дней по Камчатке`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium"
                  style={{ background: 'color-mix(in srgb, var(--ocean) 15%, transparent)', color: 'var(--ocean)', border: '1px solid color-mix(in srgb, var(--ocean) 30%, transparent)' }}
                  /* Отправка плана группе — действие исполнения (словарь steps). */
                  onClick={() => funnelBeacon('plan_sent_to_telegram', tripId ?? undefined)}>
                  <ExternalLink className="w-3.5 h-3.5" />Telegram
                </a>
                <a href="https://max.ru/id4101147649_bot" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium"
                  style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)' }}>
                  <ExternalLink className="w-3.5 h-3.5" />MAX
                </a>
              </div>
              <p className="text-xs break-all" style={{ color: 'var(--text-muted)' }}>{shareUrl}</p>
            </div>
          )}

          {contactBlock}
        </>
      )}
    </div>
  );

  const planPanel = (
    <div className="flex flex-col h-full min-h-0">
      <div ref={planScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {formOpen || !recommendation ? stepsView : resultsView}
      </div>
      {(formOpen || !recommendation) && stepBar}
    </div>
  );

  // ── Map panel content ──────────────────────────────────────────────────────

  const mapPanel = (
    <div className="relative w-full h-full">
      <LeafletMap
        markers={mapMarkers}
        center={MAP_CENTER}
        zoom={6}
        height="100%"
        className="rounded-none border-0"
        onMarkerClick={handleMarkerClick}
      />

      {/* Hint / Loading */}
      {bgLoading && bgRoutes.length === 0 && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-2 text-xs text-[var(--text-muted)] flex items-center gap-2 shadow-sm">
            <Loader className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            Загружаем маршруты...
          </div>
        </div>
      )}

      {/* Edit mode banner on map */}
      {editingDayInfo && (
        <div className="absolute top-4 left-4 right-4 lg:right-auto lg:max-w-sm pointer-events-auto z-10">
          <div className="bg-[var(--bg-card)] border border-[var(--accent)] rounded-lg px-4 py-2.5 shadow-lg flex items-center gap-3">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
              style={{ background: 'var(--accent)' }}>
              {editingDayInfo.idx + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                Замена: {editingDayInfo.title}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">
                Кликните любую точку на карте
              </p>
            </div>
            <button onClick={() => setEditingDayId(null)}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Background routes count badge (when not in edit mode) */}
      {bgRoutes.length > 0 && !editingDayInfo && (
        <div className="absolute top-4 left-4 pointer-events-none">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-secondary)] flex items-center gap-2 shadow-sm">
            <div className="flex gap-0.5">
              <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} />
              <div className="w-2 h-2 rounded-full" style={{ background: 'var(--ocean)' }} />
              <div className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
              <div className="w-2 h-2 rounded-full" style={{ background: 'var(--purple)' }} />
            </div>
            {bgRoutes.length} маршрутов по зонам
          </div>
        </div>
      )}

      {/* Route detail card overlay */}
      {selectedRoute && (
        <div className="absolute bottom-4 left-4 right-4 lg:right-auto lg:w-80 z-10">
          <RouteDetailCard
            route={selectedRoute}
            days={days}
            editingDayId={editingDayId}
            onReplace={dayNum => replaceDay(dayNum, selectedRoute)}
            onAddDay={() => addRouteAsDay(selectedRoute)}
            onClose={() => setSelectedRoute(null)}
          />
        </div>
      )}
    </div>
  );

  // ── Layout ──────────────────────────────────────────────────────────────────

  if (done) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '100dvh', paddingTop: PLANNER_HEADER_OFFSET, boxSizing: 'border-box' }}>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-10 md:p-16 text-center max-w-md mx-4">
          <div className="w-12 h-12 rounded-full bg-[var(--success)]/15 flex items-center justify-center mx-auto mb-4">
            <Check className="w-6 h-6 text-[var(--success)]" />
          </div>
          <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">Готово!</h2>
          <p className="text-sm text-[var(--text-secondary)]">Ваши предпочтения отправлены. Скоро свяжемся с вами.</p>
        </div>
      </div>
    );
  }

  return (
    // Корень экрана начинается ПОД фиксированной шапкой сайта (planner-layout):
    // до 26.09 он стоял с верхнего края окна, и полоса «План / Карта» на
    // телефоне ложилась поверх иконок шапки — поиска, темы, SOS, профиля.
    <div data-planner-root className="flex flex-col"
      style={{ height: '100dvh', minHeight: 500, paddingTop: PLANNER_HEADER_OFFSET, boxSizing: 'border-box' }}>

      {/* Mobile tab bar */}
      <MobileTabBar
        active={mobileTab}
        onChange={setMobileTab}
        editingDay={editingDayInfo}
      />

      {/* Desktop: side-by-side. Mobile: tab-switched */}
      <div className="flex flex-1 min-h-0">

        {/* Map (left on desktop, shown when map tab active on mobile) */}
        <div className={`flex-1 min-h-0 ${mobileTab === 'map' ? 'block' : 'hidden'} lg:block`}>
          {mapPanel}
        </div>

        {/* Plan panel (right on desktop, shown when plan tab active on mobile) */}
        <div className={`w-full lg:w-[420px] shrink-0 min-h-0 flex-col lg:border-l border-[var(--border)] bg-[var(--bg-primary)] ${
          mobileTab === 'plan' ? 'flex' : 'hidden'
        } lg:flex`}>
          {planPanel}
        </div>
      </div>

      {/* Partners modal */}
      {partnersModal && (
        <PartnersModal activityType={partnersModal.activityType} onClose={() => setPartnersModal(null)} />
      )}

      {/* Companion widget — available during trip planning */}
      {days.length > 0 && (
        <CompanionWidget days={days} arrival={arrival} departure={departure} />
      )}
    </div>
  );
}
