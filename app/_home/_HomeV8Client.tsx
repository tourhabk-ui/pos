'use client';

/**
 * Главная v8 «Воронка» — фото-первый герой + честные приборы (мобильная главная).
 * Отличия от v7-прототипа (по договорённости с владельцем):
 *   - Герой на реальном фото Камчатки, не на градиенте-заглушке.
 *   - Блок безопасности — реальные данные: KVERT ACC (volcano_status) +
 *     лента external_alerts. Фейковой сейсмоленты и компаса нет.
 *   - Платы — реальные туры/маршруты с фото и ценой (queryCatalog).
 *   - Лид-форма шлёт реальный POST /api/leads (lead-processor).
 *   - SOS окрашен в --danger, отдельно от коммерческой оранжевой.
 *   - Эко-баллы не показываем: начисление в коде не подключено (нечестно).
 * Данные приходят из серверного data-слоя (app/_home/data.ts).
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { Flame, Snowflake, Waves, Droplets, Trees, Home, Map as MapIcon, Compass, Navigation, Siren, LayoutGrid, Sparkles, Sun, Moon, Phone, X, ChevronDown, MapPin, User, type LucideIcon } from 'lucide-react';
import type { HomeV8Data, SafetyAlert } from './data';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';
import { TrailReportSheet } from '@/components/homepage/TrailReportSheet';

const ELEMENT_ICON: Record<string, LucideIcon> = {
  fire: Flame, snow: Snowflake, ocean: Waves, therm: Droplets, nature: Trees,
};

const CHIPS = ['Вулканы', 'Рыбалка', 'Медведи', 'Океан', 'Термы', 'Хели-ски'];

const ACC_LABEL: Record<string, string> = { red: 'красный', orange: 'оранжевый', yellow: 'жёлтый' };
const ACC_VAR: Record<string, string> = { red: 'var(--brusnika)', orange: 'var(--shroom)', yellow: 'var(--amber)' };

function fmtPrice(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}
function fmtAgo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const min = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

// Абсолютная дата новости для ленты алертов: у МЧС/дорожных сводок важно ВИДЕТЬ
// само число (июльское закрытие ≠ свежее), а не только «N дн назад».
function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function magColor(m: number): string {
  if (m >= 6) return 'var(--brusnika)';
  if (m >= 4.5) return 'var(--shroom)';
  if (m >= 3) return 'var(--amber)';
  return 'var(--tide)';
}
const SRC_LABEL: Record<string, string> = { kbgsras: 'КБГС РАН', usgs: 'USGS', none: '' };

export default function HomeV8Client({ data }: { data: HomeV8Data }) {
  const { safety, seismic, radar, plates, feed, stats, elements } = data;
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [chips, setChips] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plateIdx, setPlateIdx] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const leadRef = useRef<HTMLDivElement | null>(null);
  const platesRef = useRef<HTMLDivElement | null>(null);

  // По умолчанию тёмная; если пользователь ранее выбрал светлую — восстанавливаем.
  useEffect(() => {
    const saved = localStorage.getItem('v8-theme');
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-v7theme', theme);
    return () => document.documentElement.removeAttribute('data-v7theme');
  }, [theme]);

  const chooseTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    try { localStorage.setItem('v8-theme', t); } catch { /* приватный режим */ }
  };

  // Карусель «Куда сегодня»: автопрокрутка + точки, пауза при касании.
  useEffect(() => {
    const c = platesRef.current;
    if (!c || plates.length < 2) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stride = () => {
      const first = c.firstElementChild as HTMLElement | null;
      return first ? first.getBoundingClientRect().width + 14 : c.clientWidth;
    };
    let idx = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let pauseTimer: ReturnType<typeof setTimeout>;
    const go = (i: number) => {
      idx = (i + plates.length) % plates.length;
      c.scrollTo({ left: idx * stride(), behavior: rm ? 'auto' : 'smooth' });
      setPlateIdx(idx);
    };
    const onScroll = () => {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        const i = Math.round(c.scrollLeft / stride());
        if (i !== idx) { idx = i; setPlateIdx(i); }
      }, 90);
    };
    const start = () => { if (!rm && !timer) timer = setInterval(() => go(idx + 1), 5000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onUp = () => { setTimeout(start, 8000); };
    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('pointerdown', stop, { passive: true });
    c.addEventListener('pointerup', onUp);
    start();
    return () => {
      stop(); clearTimeout(pauseTimer);
      c.removeEventListener('scroll', onScroll);
      c.removeEventListener('pointerdown', stop);
      c.removeEventListener('pointerup', onUp);
    };
  }, [plates.length]);

  const goPlate = (i: number) => {
    const c = platesRef.current;
    if (!c) return;
    const first = c.firstElementChild as HTMLElement | null;
    const stride = first ? first.getBoundingClientRect().width + 14 : c.clientWidth;
    c.scrollTo({ left: i * stride, behavior: 'smooth' });
    setPlateIdx(i);
  };

  const jumpToLead = () => {
    leadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // СОС: онлайн — уходим на полноценный /sos; офлайн — не даём навигации
  // (она бы упала на «Нет соединения») и открываем инлайн-панель на главной.
  const sosClick = (e: React.MouseEvent) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      e.preventDefault();
      setSosOpen(true);
    }
  };

  const submitLead = async () => {
    setErr(null);
    if (name.trim().length < 2) { setErr('Укажите имя'); return; }
    if (phone.trim().length < 7) { setErr('Укажите телефон или Telegram'); return; }
    setSending(true);
    try {
      const interests = CHIPS.filter((c) => chips[c]);
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          comment: interests.length ? `Интересы: ${interests.join(', ')}` : undefined,
          source_url: typeof window !== 'undefined' ? window.location.pathname : undefined,
        }),
      });
      if (!res.ok) throw new Error('fail');
      setSent(true);
    } catch {
      setErr('Не удалось отправить. Попробуйте ещё раз или напишите в Telegram.');
    } finally {
      setSending(false);
    }
  };

  const heroImg = theme === 'dark' ? '/images/hero/hero-dark.jpeg' : '/images/hero/hero-light.jpeg';

  return (
    <div className="v7 v8" id="v8root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* шапка */}
      <div className="topbar"><div className="in">
        <span className="brand">Ведар</span>
        <span className="sp" />
        <button className="icn" aria-label="Поиск">
          <svg viewBox="0 0 24 24" className="li"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
        <button
          className="icn"
          aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          onClick={() => chooseTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark'
            ? <Sun className="li" size={19} strokeWidth={2} />
            : <Moon className="li" size={19} strokeWidth={2} />}
        </button>
        <Link href="/profile" className="icn" aria-label="Личный кабинет">
          <User className="li" size={19} strokeWidth={2} />
        </Link>
        <button className="cta-top" onClick={jumpToLead}>Хочу тур</button>
      </div></div>

      {/* ГЕРОЙ — фото-первый */}
      <header className="hero-photo" style={{ backgroundImage: `linear-gradient(180deg, rgba(10,14,12,.15) 0%, rgba(10,14,12,.55) 62%, rgba(10,14,12,.82) 100%), url('${heroImg}')` }}>
        <div className="hero-in">
          <div className="dateline"><span>Камчатка · живая сводка</span></div>
          <h1>Полуостров,<br />прочитанный <em>сегодня</em></h1>
          <p className="sub">Маршруты, безопасность и реальные туры проверенных операторов — в одном месте.</p>

          {/* три способа найти тур — каждый в свой инструмент */}
          <div className="hero-cta">
            <Link href="/routes" className="hc-btn"><LayoutGrid className="hci" size={17} strokeWidth={2} /><span>Каталог</span></Link>
            <Link href="/planner" className="hc-btn"><Sparkles className="hci" size={17} strokeWidth={2} /><span>Планировщик</span></Link>
            <Link href="/kuzmich" className="hc-btn"><Compass className="hci" size={17} strokeWidth={2} /><span>Кузьмич</span></Link>
          </div>
          {safety.volcanoes[0] && (
            <div className="kvert">
              <i style={{ background: ACC_VAR[safety.volcanoes[0].acc] }} />
              KVERT: {ACC_LABEL[safety.volcanoes[0].acc] ?? safety.volcanoes[0].acc} · {safety.volcanoes[0].name}
            </div>
          )}
        </div>
      </header>

      <div className="wrap">

        {/* I. РАДАР БЕЗОПАСНОСТИ — реальные опасности вокруг тебя */}
        <section>
          <div className="shead"><h2>Радар безопасности</h2><span className="line" /><Link className="all" href="/safety">Спасатель</Link><Link className="all" href="/map">Карта</Link></div>

          <RadarScope hazards={radar.hazards} center={radar.center} />

          <Link href="/register" className="mchsline">
            <b>Зарегистрируй маршрут в МЧС заранее</b>
            <span>Бесплатно. С гидом или сам — спасателям это спасает жизни →</span>
          </Link>

          <Link href="/safety/offline" className="protoline">
            Что делать при ЧП: медведь · холод · вулкан · потерялся
            <b>работает без сети →</b>
          </Link>

          {/* Навигатор — жёсткая ссылка (не Next Link): чтобы офлайн грузилась
              закэшированная страница, а не заглушка «Нет соединения». */}
          <a href="/planning?mode=trail" className="protoline">
            Навигатор по маршруту: компас до точки, высота, трек
            <b>работает без сети →</b>
          </a>

          <button type="button" className="reportbtn" onClick={() => setReportOpen(true)}>
            Сообщить о наблюдении <span>медведь · лавина · состояние тропы →</span>
          </button>

          {(safety.alerts.length > 0 || seismic.events.length > 0) && (
            <div className="safety">
              {safety.alerts.length > 0 && <AlertsTicker alerts={safety.alerts} />}
              {seismic.events.length > 0 && (
                <SeismicPulse events={seismic.events} source={SRC_LABEL[seismic.source]} />
              )}
              <div className="src">Источник: КВЕРТ · Камчатское УГМС · КБГС РАН / USGS{safety.updatedAt ? ` · обновлено ${fmtAgo(safety.updatedAt)}` : ''}</div>
            </div>
          )}
        </section>

        {/* II. ПЛАТЫ — реальные туры/маршруты с фото и ценой */}
        {plates.length > 0 && (
          <section>
            <div className="shead"><h2>Куда сегодня</h2><span className="line" /><Link className="all" href="/routes">Все</Link></div>
            <div className="plates" ref={platesRef}>
              {plates.map((p) => {
                const href = p.kind === 'tour' ? `/marketplace/tours/${p.id}` : `/routes/${p.id}`;
                const price = fmtPrice(p.priceFrom);
                return (
                  <figure className="plate" key={p.id}>
                    <Link href={href}><div className="img" style={p.imageUrl ? { backgroundImage: `url('${p.imageUrl}')` } : undefined}>
                      {!p.imageUrl && <span className="noimg" />}
                    </div></Link>
                    <div className="row"><b>{p.title}</b></div>
                    {p.description && <div className="cap">{p.description}</div>}
                    <div className="buy">
                      {price ? <span className="price">от {price}</span> : <span className="price muted">Цена по запросу</span>}
                      <Link href={href}>{p.kind === 'tour' ? 'Смотреть тур' : 'Открыть'}</Link>
                    </div>
                  </figure>
                );
              })}
            </div>
            {plates.length > 1 && (
              <div className="pl-dots">
                {plates.map((_, i) => (
                  <button key={i} className={i === plateIdx ? 'on' : ''} aria-label={`Плата ${i + 1}`} onClick={() => goPlate(i)} />
                ))}
              </div>
            )}
            {feed.length > 0 && (
              <div className="arrivals"><span className="k">Журнал</span><span className="t">{feed[0].text}</span></div>
            )}
          </section>
        )}

        {/* III. КУЗЬМИЧ */}
        <section>
          <div className="shead"><h2>Проводник Кузьмич</h2><span className="line" /></div>
          <div className="guide">
            <q>Скажите, что хотите увидеть — соберу маршрут по реальным статусам и передам проверенному оператору.</q>
            <div className="sig"><span className="caps">Кузьмич</span><span className="dot" /><span className="mono">по данным, не по слухам</span></div>
            <div className="acts">
              <Link href="/kuzmich">Спросить</Link>
              <a className="lead" onClick={(e) => { e.preventDefault(); jumpToLead(); }} href="#lead">Подобрать тур</a>
            </div>
          </div>
        </section>

        {/* IV. СТИХИИ — реальные счётчики */}
        {elements.length > 0 && (
          <section>
            <div className="shead"><h2>Стихии</h2><span className="line" /><Link className="all" href="/routes">Все места</Link></div>
            <div className="elements">
              {elements.map((el, i) => {
                const Icon = ELEMENT_ICON[el.key] ?? Flame;
                const wide = elements.length % 2 === 1 && i === elements.length - 1;
                return (
                  <Link className={`etile et-${el.key}`} href={el.href} key={el.key}
                    style={wide ? { gridColumn: 'span 2' } : undefined}>
                    <span className="glass">
                      <Icon className="eicon" size={24} strokeWidth={1.6} aria-hidden />
                      <b>{el.label}</b>
                      <span className="ecnt">{el.count} мест</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* V. ЦИФРЫ */}
        <section>
          <div className="shead"><h2>В цифрах</h2><span className="line" /></div>
          <div className="dataline">
            {stats.map((s, i) => (
              s.href
                ? <Link className="dl link" href={s.href} key={i}><div className="n">{s.value}</div><div className="t">{s.label} →</div></Link>
                : <div className="dl" key={i}><div className="n">{s.value}</div><div className="t">{s.label}</div></div>
            ))}
          </div>
        </section>

        {/* VI. ЛИД-ФОРМА — реальный POST /api/leads */}
        <section ref={leadRef} id="lead">
          <div className="shead"><h2>Собрать поездку</h2><span className="line" /></div>
          <div className={`lead${sent ? ' sent' : ''}`}>
            <h3>Не знаете, <em>с чего начать</em>?</h3>
            <p>Опишите поездку — подберём маршруты и передадим проверенным операторам. Ответ сегодня.</p>
            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c} className="chip" aria-pressed={!!chips[c]}
                  onClick={() => setChips((s) => ({ ...s, [c]: !s[c] }))}>{c}</button>
              ))}
            </div>
            <div className="field2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас зовут" aria-label="Имя" />
              <div className="field">
                <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Телефон или Telegram" aria-label="Контакт" />
                <button onClick={submitLead} disabled={sending}>{sending ? '…' : 'Отправить'}</button>
              </div>
            </div>
            {err && <div className="err">{err}</div>}
            <div className="fine">Данные уходят только операторам по вашему запросу. Без спама.</div>
            <div className="ok">Заявка принята. Кузьмич собирает подборку — оператор ответит в течение дня.</div>
          </div>
        </section>

        {/* VII. РАЗДЕЛЫ */}
        <section>
          <div className="shead"><h2>Разделы</h2><span className="line" /></div>
          <div className="hubline">
            <Link href="/routes">Туристам</Link><Link href="/routes?activity_type=fishing">Рыбалка</Link>
            <Link href="/hub">Операторам</Link><Link href="/guides">Гидам</Link>
            <Link href="/accommodations">Жильё</Link><Link href="/gear">Снаряжение</Link><Link href="/transfers">Трансферы</Link>
          </div>
        </section>

      </div>

      {/* Сообщить о наблюдении (trail_reports) — восстановлено на v8 после свапа
          мобильной Главной; шторка сама рендерит оверлей. */}
      <TrailReportSheet open={reportOpen} onClose={() => setReportOpen(false)} />

      {/* SOS — онлайн ведёт на полноценный /sos; офлайн (где /sos не поднимется
          из-за RSC-подкачки) открывает инлайн-панель поверх главной. */}
      <Link href="/sos" className="sos" aria-label="SOS — экстренная помощь" onClick={sosClick}>SOS</Link>

      {/* нижняя навигация */}
      <nav className="tabs"><div className="in">
        <Link href="/" className="active"><span className="ico"><Home className="ti" size={19} strokeWidth={2} /></span><span>Дом</span></Link>
        <Link href="/map"><span className="ico"><MapIcon className="ti" size={19} strokeWidth={2} /></span><span>Карта</span></Link>
        <Link href="/kuzmich"><span className="ico"><Compass className="ti" size={19} strokeWidth={2} /></span><span>Кузьмич</span></Link>
        <a href="/planning?mode=trail"><span className="ico"><Navigation className="ti" size={19} strokeWidth={2} /></span><span>На маршруте</span></a>
        <Link href="/sos" className="sos-tab" onClick={sosClick}><span className="ico"><Siren className="ti" size={18} strokeWidth={2.2} /></span><span>СОС</span></Link>
      </div></nav>

      <EmergencyPanel open={sosOpen} onClose={() => setSosOpen(false)} />
    </div>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  critical: 'var(--brusnika)', danger: 'var(--shroom)', warning: 'var(--amber)',
};
const KIND_LABEL: Record<string, string> = { volcano: 'Вулкан', thermal: 'Термы', quake: 'Сейсмика' };
const MAX_KM = 200; // внешнее кольцо

interface RadarHazard { lat: number; lng: number; level: string; kind: string; label: string; note: string }
interface Placed extends RadarHazard { x: number; y: number; dist: number }

/**
 * Радар безопасности: реальные опасные точки (вулканы KVERT, термы, сейсмика)
 * по настоящему азимуту и расстоянию от центра. Центр — геолокация (если
 * разрешена) или Петропавловск. Луч-развёртка декоративен поверх реальных
 * блипов; несуществующих точек не рисуем.
 */
function RadarScope({ hazards, center }: { hazards: RadarHazard[]; center: { lat: number; lng: number; label: string } }) {
  const [c, setC] = useState(center);
  const [geo, setGeo] = useState<'idle' | 'ok' | 'deny'>('idle');
  const [sel, setSel] = useState<Placed | null>(null);
  const [copied, setCopied] = useState(false);

  const copyCoords = () => {
    const t = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    navigator.clipboard?.writeText(t)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setGeo('deny'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setC({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'Ваше местоположение' }); setGeo('ok'); setSel(null); },
      () => setGeo('deny'),
      { timeout: 8000, maximumAge: 300000 },
    );
  };

  const R = 92, CX = 100, CY = 100;
  const kmLat = 111.32, kmLng = 111.32 * Math.cos((c.lat * Math.PI) / 180);
  const placed: Placed[] = hazards
    .map((h) => {
      const north = (h.lat - c.lat) * kmLat;
      const east = (h.lng - c.lng) * kmLng;
      const dist = Math.hypot(north, east);
      return { ...h, dist, x: CX + (east / MAX_KM) * R, y: CY - (north / MAX_KM) * R };
    })
    .filter((h) => h.dist <= MAX_KM)
    .sort((a, b) => (a.level === 'critical' ? -1 : 0) - (b.level === 'critical' ? -1 : 0));

  const rings = [0.25, 0.5, 1]; // 50 / 100 / 200 км

  return (
    <div className="radar">
      <div className="scope">
        <svg viewBox="0 0 200 200" aria-label="Радар безопасности">
          <defs>
            <radialGradient id="sweepGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--radar)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--radar)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {rings.map((k, i) => (
            <circle key={i} cx={CX} cy={CY} r={R * k} fill="none" stroke="var(--radar)" strokeOpacity={0.28} strokeWidth={0.8} />
          ))}
          <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="var(--radar)" strokeOpacity={0.18} strokeWidth={0.7} />
          <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="var(--radar)" strokeOpacity={0.18} strokeWidth={0.7} />
          <text x={CX} y={CY - R - 3} textAnchor="middle" className="rn">С</text>
          <g className="sweep">
            <path d={`M ${CX} ${CY} L ${CX} ${CY - R} A ${R} ${R} 0 0 1 ${CX + R * Math.sin(0.7)} ${CY - R * Math.cos(0.7)} Z`} fill="url(#sweepGrad)" />
            <line x1={CX} y1={CY} x2={CX} y2={CY - R} stroke="var(--radar)" strokeOpacity={0.7} strokeWidth={1} />
          </g>
          <circle cx={CX} cy={CY} r={2.4} fill="var(--radar)" />
          {placed.map((h, i) => (
            <g key={i} onClick={() => setSel(h)} style={{ cursor: 'pointer' }}>
              {h.level === 'critical' && <circle cx={h.x} cy={h.y} r={6} className="pulse" fill={LEVEL_COLOR[h.level]} />}
              <circle cx={h.x} cy={h.y} r={h.level === 'critical' ? 4 : h.level === 'danger' ? 3.2 : 2.6}
                fill={LEVEL_COLOR[h.level]} stroke="#fff" strokeWidth={0.6}
                style={sel === h ? { filter: 'drop-shadow(0 0 4px currentColor)' } : undefined} />
            </g>
          ))}
        </svg>
        {placed.length === 0 && <div className="clean">Рядом опасностей нет</div>}
      </div>

      <div className="rmeta">
        <div className="rrow">
          <span className="rc">Центр: <b>{c.label}</b></span>
          {geo !== 'ok' && <button className="rgeo" onClick={useMyLocation}>Моё местоположение</button>}
        </div>
        {geo === 'ok' && (
          <button className="rcoord" onClick={copyCoords} title="Скопировать координаты">
            {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
            <span>{copied ? 'скопировано' : 'копировать'}</span>
          </button>
        )}
        {geo === 'deny' && <div className="rhint">Геолокация недоступна — показываю от Петропавловска.</div>}
        {sel ? (
          <button className="rsel" onClick={() => setSel(null)}>
            <span className="rdot" style={{ background: LEVEL_COLOR[sel.level] }} />
            <span className="rtx"><b>{sel.label}</b><span>{KIND_LABEL[sel.kind]} · {Math.round(sel.dist)} км · {sel.note}</span></span>
          </button>
        ) : (
          <div className="rleg">
            <span><i style={{ background: LEVEL_COLOR.critical }} />критично</span>
            <span><i style={{ background: LEVEL_COLOR.danger }} />опасно</span>
            <span><i style={{ background: LEVEL_COLOR.warning }} />внимание</span>
            <span className="rcount">{placed.length} рядом</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface PulseQuake { magnitude: number; place: string; time: number; depth: number | null }

/**
 * Живая лента предупреждений — компактное окно ~4 строки с плавной вертикальной
 * прокруткой (экономит место на мобильном). Только актуальные алерты (фильтр и
 * срок годности — на стороне data.ts). При 1-2 записях не крутим — статичный
 * список; при большем числе — бесшовный цикл (список продублирован).
 *
 * Взаимодействие: тап РАСКРЫВАЕТ ленту в полный читаемый список и сворачивает
 * обратно. Раньше единственной реакцией была пауза анимации по :hover/:focus —
 * на телефоне тап давал «залипший» эмулированный hover, и лента просто
 * замирала на середине, не раскрываясь (фидбэк владельца). Теперь развёрнутое
 * состояние — статичный скроллящийся список без маски и без бегущей анимации.
 */
function AlertsTicker({ alerts }: { alerts: SafetyAlert[] }) {
  const scroll = alerts.length > 2;
  const [open, setOpen] = useState(false);
  const animate = scroll && !open; // бегущая строка только в свёрнутом длинном списке
  const row = (a: SafetyAlert, i: number, dup: boolean) => (
    <li key={`${dup ? 'd' : 'a'}-${i}`} aria-hidden={dup || undefined}>
      <i className={a.severity >= 3 ? 'sev-hi' : a.severity === 2 ? 'sev-mid' : 'sev-lo'} />
      <span className="atx">
        {a.title}
        {a.description ? <span className="adesc">{a.description}</span> : null}
      </span>
      <span className="ago">{fmtDate(a.at)}{a.at ? ` · ${fmtAgo(a.at)}` : ''}</span>
    </li>
  );
  return (
    <div className={`ticker${scroll ? ' scroll' : ''}${open ? ' open' : ''}`}>
      <ul
        className="alerts ticker-track"
        style={animate ? { animationDuration: `${Math.max(16, alerts.length * 5)}s` } : undefined}
      >
        {alerts.map((a, i) => row(a, i, false))}
        {animate && alerts.map((a, i) => row(a, i, true))}
      </ul>
      {scroll && (
        <button
          type="button"
          className={`ticker-toggle${open ? ' open' : ''}`}
          aria-expanded={open}
          aria-label={open ? 'Свернуть ленту предупреждений' : 'Показать все предупреждения'}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className="tchev" size={16} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

/**
 * «Пульс полуострова» — реальные сейсмособытия (КБГС РАН / USGS) ритмом, а не
 * списком: сильнейший толчок крупно + столбики по магнитуде (свежие справа).
 * Тап по столбику → деталь. Столбики = настоящие события, не синтетика.
 */
function SeismicPulse({ events, source }: { events: PulseQuake[]; source: string }) {
  const [sel, setSel] = useState<number | null>(null);
  if (events.length === 0) return null;
  const strongest = events.reduce((a, b) => (b.magnitude > a.magnitude ? b : a), events[0]);
  const bars = [...events].reverse(); // events: свежие первыми → разворот, чтобы свежие были справа
  const maxMag = Math.max(6, ...events.map((e) => e.magnitude));
  const selected = sel != null ? bars[sel] : null;
  return (
    <div className="pulse">
      <div className="phead">
        <div className="pbig">
          <b>M{strongest.magnitude.toFixed(1)}</b>
          <span>сильнейший · {strongest.depth != null ? `${Math.round(strongest.depth)} км · ` : ''}{fmtAgo(new Date(strongest.time).toISOString())}</span>
        </div>
        <div className="psrc">Пульс полуострова<i>{source}</i></div>
      </div>
      <div className="pbars">
        {bars.map((q, i) => (
          <button key={i} className={`pbar${sel === i ? ' on' : ''}`}
            style={{ height: `${Math.max(12, (q.magnitude / maxMag) * 100)}%`, background: magColor(q.magnitude) }}
            aria-label={`M${q.magnitude.toFixed(1)}`} onClick={() => setSel(sel === i ? null : i)} />
        ))}
      </div>
      <div className="paxis"><span>старее</span><span>сейчас →</span></div>
      {selected ? (
        <button className="psel" onClick={() => setSel(null)}>
          <span className="pmag" style={{ background: magColor(selected.magnitude) }}>{selected.magnitude.toFixed(1)}</span>
          <span className="ptx"><b>{selected.place}</b><span>{selected.depth != null ? `${Math.round(selected.depth)} км · ` : ''}{fmtAgo(new Date(selected.time).toISOString())}</span></span>
        </button>
      ) : (
        <div className="psum">за ~48 ч — {events.length} толчков · макс M{strongest.magnitude.toFixed(1)}</div>
      )}
    </div>
  );
}

/**
 * Инлайн-панель экстренной помощи — открывается ПОВЕРХ главной, без перехода
 * на другую страницу и без сети. Всё критичное зашито статикой: звонки (tel:),
 * координаты (navigator.geolocation), протоколы (текст). Полевой тест на Трёх
 * братьях показал, что офлайн выживает только контент на уже загруженной
 * главной — навигация на /sos умирает (Next тянет данные экрана по сети).
 * Номера — из единого источника lib/safety/emergency-numbers.ts. Протоколы — из /safety/offline.
 */
// Единый источник номеров (см. lib/safety/emergency-numbers.ts).
// tel: — только цифры и «+»: форматированный «+7 (4152) 30-10-89» с пробелами
// ломает tel-ссылку на части устройств.
const EMG_CALLS: { label: string; num: string; tel: string; primary?: boolean }[] =
  EMERGENCY_NUMBERS.map((c) => ({
    label: c.name,
    num: c.phone,
    tel: c.phone.replace(/[^\d+]/g, ''),
    primary: c.primary,
  }));

const EMG_PROTOCOLS: { id: string; title: string; urgent: string; steps: string[] }[] = [
  {
    id: 'bear', title: 'Медведь', urgent: 'Никогда не беги — сработает инстинкт преследования',
    steps: [
      'Остановись. Говори спокойным низким голосом — покажи, что ты человек.',
      'Медленно отступай боком, не поворачивайся спиной.',
      'Подними руки — выгляди крупнее. Антизверь наготове.',
      'Приближается — шуми, бей в кастрюлю, кричи.',
      'Нападение: бей в нос и глаза. Не ложись — только активное сопротивление.',
      'Медведица с медвежатами опаснее всего — уходи немедленно.',
    ],
  },
  {
    id: 'hypothermia', title: 'Гипотермия', urgent: 'Дрожь прекратилась, человек вялый — критическая стадия',
    steps: [
      'Убери от ветра, сними мокрое, укутай в спальник, поделись теплом тела.',
      'Нет дрожи, спутанность: горизонтально, не двигай — может остановить сердце.',
      'Тёплое питьё — только если в сознании и глотает сам. Алкоголь запрещён.',
      'Грей тело (грудь, подмышки, пах), не конечности.',
      'Мокрая одежда крадёт тепло в 25× быстрее. Приоритет — сухость.',
      'Звони 112, передай координаты, не оставляй одного.',
    ],
  },
  {
    id: 'lost', title: 'Потерялся', urgent: 'СТОП — стой где стоишь, не паникуй',
    steps: [
      'S.T.O.P.: стой, думай, осмотрись, планируй.',
      'Не иди наугад — каждый шаг удаляет от зоны поиска.',
      'Нужна вода/люди — иди вниз по склону к реке.',
      'Три костра треугольником — сигнал бедствия.',
      'Ночлег: лапник 15 см — тепло снизу важнее укрытия сверху.',
      'Береги заряд: авиарежим, геолокацию включай только для звонка.',
    ],
  },
  {
    id: 'volcano', title: 'Вулкан', urgent: 'Запах серы + тремор земли = уходи немедленно',
    steps: [
      'Признаки: запах серы, подземный гул, тремор, гибель птиц.',
      'Пепел: закрой рот и нос тканью, двигайся перпендикулярно ветру.',
      'Лавовый поток медленный — уходи вверх по склону, в сторону от потока.',
      'Термальные поля: не ступай на белую/жёлтую землю — под коркой кипяток.',
    ],
  },
];

function EmergencyPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<'idle' | 'ok' | 'deny'>('idle');
  const [copied, setCopied] = useState(false);
  const [openProto, setOpenProto] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !navigator.geolocation) { if (open) setGeoState('deny'); return; }
    setGeoState('idle');
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }); setGeoState('ok'); },
      () => setGeoState('deny'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }, [open]);

  if (!open) return null;

  const coordText = coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : '';
  const copy = () => {
    if (!coordText) return;
    navigator.clipboard?.writeText(coordText)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };
  const smsBody = coords ? `SOS. Нужна помощь. Мои координаты: ${coordText}` : 'SOS. Нужна помощь.';

  return (
    <div className="emg" role="dialog" aria-label="Экстренная помощь">
      <div className="emg-top">
        <b>Экстренная помощь</b>
        <button className="emg-x" onClick={onClose} aria-label="Закрыть"><X size={20} strokeWidth={2.2} /></button>
      </div>

      <div className="emg-scroll">
        {/* Координаты — работают без сети */}
        <div className="emg-coord">
          <span className="emg-lbl"><MapPin size={13} strokeWidth={2} /> Твои координаты</span>
          {geoState === 'ok' && coords ? (
            <button className="emg-cval" onClick={copy}>
              {coordText}<span>{copied ? 'скопировано' : 'копировать'}</span>
            </button>
          ) : geoState === 'deny' ? (
            <span className="emg-cwait">Разреши геолокацию и включи GPS</span>
          ) : (
            <span className="emg-cwait">Определяю позицию…</span>
          )}
        </div>

        {/* Звонки — работают без интернета */}
        <div className="emg-calls">
          {EMG_CALLS.map((c) => (
            <a key={c.tel} href={`tel:${c.tel}`} className={`emg-call${c.primary ? ' emg-call-primary' : ''}`}>
              <Phone size={c.primary ? 22 : 17} strokeWidth={2.2} />
              <span className="emg-ct"><b>{c.num}</b><span>{c.label}</span></span>
            </a>
          ))}
          <a href={`sms:112?body=${encodeURIComponent(smsBody)}`} className="emg-sms">
            SMS на 112 с координатами
          </a>
        </div>

        {/* Протоколы — текст зашит, без сети */}
        <div className="emg-protos">
          <span className="emg-lbl">Что делать при ЧП</span>
          {EMG_PROTOCOLS.map((p) => (
            <div key={p.id} className="emg-proto">
              <button className="emg-phead" onClick={() => setOpenProto(openProto === p.id ? null : p.id)} aria-expanded={openProto === p.id}>
                <span className="emg-pt"><b>{p.title}</b><span>{p.urgent}</span></span>
                <ChevronDown size={16} strokeWidth={2} className={openProto === p.id ? 'emg-chev emg-chev-on' : 'emg-chev'} />
              </button>
              {openProto === p.id && (
                <ol className="emg-steps">
                  {p.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          ))}
        </div>

        <p className="emg-note">Работает без интернета. Звонок 112 проходит даже без SIM и с чужой сетью.</p>
      </div>
    </div>
  );
}

const CSS = `
.v7{
  --fd:var(--font-unbounded),system-ui,sans-serif;--fb:var(--font-manrope),system-ui,sans-serif;--fm:var(--font-jetbrains),ui-monospace,monospace;
  --pine:#2E5F46;--tide:#3E8CA3;--brusnika:#B23A32;--amber:#B4761F;--shroom:#D97B2E;--leaf:#4E8C5B;--danger:#C0392B;
}
html[data-v7theme="light"] .v7,.v7[data-v7theme="light"]{--bg:#F4F4F0;--ink:#1D2724;--muted:#66736E;--faint:#9AA5A0;--hair:rgba(29,39,36,.14);--hair-soft:rgba(29,39,36,.08);--plate:#EBECE6;--field:#FFFFFF}
html[data-v7theme="dark"] .v7,.v7[data-v7theme="dark"]{--bg:#111715;--ink:#EAEDEA;--muted:#93A09A;--faint:#5C6863;--hair:rgba(234,237,234,.16);--hair-soft:rgba(234,237,234,.08);--plate:#18201D;--field:#1A211E}
.v7,.v7[data-v7theme]{--bg:#111715;--ink:#EAEDEA;--muted:#93A09A;--faint:#5C6863;--hair:rgba(234,237,234,.16);--hair-soft:rgba(234,237,234,.08);--plate:#18201D;--field:#1A211E}
.v7 *{margin:0;padding:0;box-sizing:border-box}
.v7{font-family:var(--fb);background:var(--bg);color:var(--ink);min-height:100dvh;padding-bottom:96px;-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){.v7 *,.v7 *::before,.v7 *::after{animation:none!important;transition:none!important}}
.v7 .wrap{max-width:480px;margin:0 auto;padding:0 20px}
.v7 .li{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;display:block}
.v7 a{color:inherit;text-decoration:none}
.v7 .ptag{font:400 9px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.v7 .topbar{position:sticky;top:0;z-index:55;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--hair)}
.v7 .topbar .in{max-width:480px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:12px}
.v7 .topbar .brand{font:700 12px/1 var(--fb);letter-spacing:.42em;text-transform:uppercase;padding-left:.42em}
.v7 .topbar .sp{flex:1}
.v7 .icn{width:32px;height:32px;display:grid;place-items:center;color:var(--muted);font-size:15px;cursor:pointer;background:none;border:0}
.v7 .icn .li{width:19px;height:19px}
.v7 .cta-top{background:var(--shroom);color:#fff;border:0;font:700 10.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;padding:11px 14px;cursor:pointer;transition:transform .13s}
.v7 .cta-top:active{transform:scale(.96)}
/* ГЕРОЙ фото */
.v7 .hero-photo{position:relative;min-height:76vh;background-size:cover;background-position:center;display:flex;align-items:flex-end;color:#fff}
.v7 .hero-in{max-width:480px;margin:0 auto;padding:0 20px 30px;width:100%;text-align:center}
.v7 .hero-photo .dateline{display:flex;align-items:center;gap:12px;justify-content:center;color:rgba(255,255,255,.75)}
.v7 .hero-photo .dateline::before,.v7 .hero-photo .dateline::after{content:"";flex:0 0 30px;height:1px;background:rgba(255,255,255,.4)}
.v7 .hero-photo .dateline span{font:400 9px/1 var(--fm);letter-spacing:.18em;text-transform:uppercase}
.v7 .hero-photo h1{margin-top:16px;font:600 30px/1.14 var(--fd);letter-spacing:-.03em;text-shadow:0 2px 24px rgba(0,0,0,.4)}
.v7 .hero-photo h1 em{font-style:normal;font-weight:800;color:var(--shroom)}
.v7 .hero-photo .sub{margin:12px auto 0;font:500 13px/1.55 var(--fb);color:rgba(255,255,255,.88);max-width:32ch}
.v7 .hero-cta{margin-top:22px;display:grid;grid-template-columns:repeat(3,1fr);gap:9px;width:100%;max-width:420px}
.v7 .hc-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:14px 6px;border-radius:14px;text-decoration:none;color:#fff;font:700 10px/1.1 var(--fb);letter-spacing:.06em;text-transform:uppercase;text-align:center;backdrop-filter:blur(10px);background:rgba(10,14,12,.34);border:1px solid rgba(255,255,255,.16);transition:transform .13s ease,background .2s ease,border-color .2s ease}
.v7 .hc-btn .hci{color:#fff;transition:transform .2s ease}
.v7 .hc-btn:active{transform:scale(.96)}
.v7 .hc-btn:hover{background:rgba(10,14,12,.5);border-color:rgba(255,255,255,.3)}
.v7 .hc-btn:hover .hci{transform:translateY(-1px)}
.v7 .hero-photo .kvert{margin-top:14px;display:inline-flex;align-items:center;gap:8px;font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .hero-photo .kvert i{width:7px;height:7px;border-radius:50%}
/* секции */
.v7 section{margin-top:40px}
.v7 .shead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.v7 .shead h2{font:600 16px/1.2 var(--fd);letter-spacing:-.02em}
.v7 .shead .line{flex:1;height:1px;background:var(--hair-soft)}
.v7 .shead .all{font:600 9.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--tide)}
/* радар безопасности */
.v7{--radar:#3FB950}
.v7 .radar{border:1px solid var(--hair);border-radius:16px;padding:16px;background:radial-gradient(120% 100% at 50% 0%,color-mix(in srgb,var(--radar) 8%,transparent),transparent 70%)}
.v7 .radar .scope{position:relative;width:100%;max-width:300px;margin:0 auto}
.v7 .radar .scope svg{width:100%;height:auto;display:block;overflow:visible}
.v7 .radar .rn{font:600 8px var(--fb);fill:var(--radar);opacity:.8}
.v7 .radar .sweep{transform-origin:100px 100px;animation:radarSweep 4.5s linear infinite}
@keyframes radarSweep{to{transform:rotate(360deg)}}
.v7 .radar .pulse{animation:radarPulse 1.6s ease-out infinite;transform-origin:center;transform-box:fill-box}
@keyframes radarPulse{0%{opacity:.5;transform:scale(.6)}70%{opacity:0;transform:scale(1.8)}100%{opacity:0}}
.v7 .radar .clean{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 11px/1 var(--fb);letter-spacing:.06em;color:var(--muted);background:var(--bg);padding:6px 10px;border-radius:999px;border:1px solid var(--hair)}
.v7 .radar .rmeta{margin-top:14px}
.v7 .radar .rrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.v7 .radar .rc{font:400 10.5px/1.4 var(--fb);color:var(--muted)}
.v7 .radar .rc b{color:var(--ink);font-weight:600}
.v7 .radar .rgeo{font:600 9px/1 var(--fb);letter-spacing:.1em;text-transform:uppercase;color:var(--tide);background:none;border:1px solid color-mix(in srgb,var(--tide) 35%,transparent);border-radius:999px;padding:7px 11px;cursor:pointer;white-space:nowrap}
.v7 .radar .rhint{margin-top:6px;font:400 9px/1.4 var(--fm);color:var(--faint)}
.v7 .radar .rcoord{margin-top:6px;display:inline-flex;align-items:center;gap:8px;font:500 11px/1 var(--fm);color:var(--ink);background:none;border:none;padding:0;cursor:pointer;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.v7 .radar .rcoord span{font:600 8px/1 var(--fb);letter-spacing:.12em;text-transform:uppercase;color:var(--tide)}
.v7 .radar .rleg{margin-top:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.v7 .radar .rleg span{display:inline-flex;align-items:center;gap:5px;font:400 9.5px/1 var(--fb);color:var(--muted)}
.v7 .radar .rleg i{width:7px;height:7px;border-radius:50%}
.v7 .radar .rleg .rcount{margin-left:auto;font:400 9px/1 var(--fm);color:var(--faint)}
.v7 .radar .rsel{margin-top:12px;width:100%;display:flex;align-items:center;gap:11px;text-align:left;background:var(--bg-hover,color-mix(in srgb,var(--ink) 5%,transparent));border:1px solid var(--hair);border-radius:12px;padding:11px 12px;cursor:pointer;font-family:var(--fb)}
.v7 .radar .rsel .rdot{width:9px;height:9px;border-radius:50%;flex:none}
.v7 .radar .rsel .rtx{display:flex;flex-direction:column;gap:3px}
.v7 .radar .rsel .rtx b{font:600 12.5px/1.2 var(--fd);color:var(--ink)}
.v7 .radar .rsel .rtx span{font:400 10px/1.4 var(--fb);color:var(--muted)}
/* безопасность */
.v7 .safety{border:1px solid var(--hair);padding:16px;margin-top:14px}
.v7 .safety.calm{display:flex;flex-direction:column;gap:6px}
.v7 .safety.calm b{font:600 15px/1.3 var(--fd);color:var(--pine)}
.v7 .safety.calm span{font:400 11.5px/1.5 var(--fb);color:var(--muted)}
.v7 .volc{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.v7 .vchip{display:inline-flex;align-items:center;gap:6px;font:600 11px/1 var(--fb);border:1px solid var(--hair);padding:7px 10px;border-radius:999px}
.v7 .vchip i{width:7px;height:7px;border-radius:50%}
.v7 .vchip small{font:400 9px/1 var(--fm);color:var(--faint);text-transform:uppercase;letter-spacing:.08em}
/* Живая лента предупреждений — компактное окно ~4 строки с вертикальной прокруткой */
.v7 .ticker{position:relative;overflow:hidden}
.v7 .ticker.scroll{height:76px;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 84%,transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 84%,transparent 100%)}
.v7 .ticker.scroll .ticker-track{animation:v7-ticker linear infinite;will-change:transform}
/* Курсор мыши на десктопе ставит бегущую строку на паузу, чтобы успеть прочитать.
   На тач-устройствах :hover не используем — там открытие/закрытие делает тап (см. .ticker-toggle). */
@media (hover:hover){.v7 .ticker.scroll:not(.open):hover .ticker-track{animation-play-state:paused}}
/* Развёрнутое состояние: полный читаемый список, без маски и без бегущей анимации,
   с обычной вертикальной прокруткой если не влезает. */
.v7 .ticker.scroll.open{height:auto;max-height:min(58vh,420px);overflow-y:auto;-webkit-overflow-scrolling:touch;-webkit-mask-image:none;mask-image:none}
.v7 .ticker.scroll.open .ticker-track{animation:none;transform:none}
/* Кнопка-переключатель. Свёрнутая лента — вся площадь тап-цель (шеврон в углу);
   развёрнутая — компактная кнопка сворачивания в углу, чтобы список можно было листать. */
.v7 .ticker-toggle{position:absolute;border:0;background:transparent;cursor:pointer;color:var(--faint);display:flex;align-items:flex-end;justify-content:flex-end;padding:6px;z-index:2}
.v7 .ticker-toggle:not(.open){inset:0;width:100%}
.v7 .ticker-toggle.open{top:2px;right:2px;padding:6px;border-radius:999px;background:var(--card);border:1px solid var(--hair)}
.v7 .ticker-toggle .tchev{transition:transform .2s ease;opacity:.7}
.v7 .ticker-toggle.open .tchev{transform:rotate(180deg);opacity:1}
@keyframes v7-ticker{from{transform:translateY(0)}to{transform:translateY(-50%)}}
.v7 .alerts{list-style:none}
.v7 .alerts li{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-top:1px solid var(--hair-soft)}
.v7 .ticker:not(.scroll) .alerts li:first-child{border-top:0}
.v7 .alerts li i{width:6px;height:6px;border-radius:50%;flex:none;align-self:center}
.v7 .alerts i.sev-hi{background:var(--brusnika)}.v7 .alerts i.sev-mid{background:var(--amber)}.v7 .alerts i.sev-lo{background:var(--tide)}
.v7 .alerts .atx{font:500 12px/1.4 var(--fb);flex:1}
.v7 .alerts .adesc{display:block;margin-top:2px;font:400 10.5px/1.35 var(--fb);color:var(--faint)}
.v7 .alerts .ago{font:400 8.5px/1 var(--fm);color:var(--faint);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.v7 .ticker.scroll{height:auto;-webkit-mask-image:none;mask-image:none}.v7 .ticker.scroll .ticker-track{animation:none}}
.v7 .safety .src{margin-top:12px;padding-top:10px;border-top:1px solid var(--hair-soft);font:400 8.5px/1.4 var(--fm);color:var(--faint)}
/* Действия безопасности — карточки, а не «поля формы»: заливка --plate +
   семантическая левая грань (МЧС=danger, офлайн-инструменты=tide, наблюдение=
   amber) + мягкая тень + подъём. Пунктир убран (читался как поле ввода). */
.v7 .mchsline{display:flex;flex-direction:column;gap:2px;margin-top:14px;padding:12px 14px 12px 15px;border-radius:14px;text-decoration:none;background:color-mix(in srgb,var(--danger) 9%,transparent);border:1px solid color-mix(in srgb,var(--danger) 22%,transparent);border-left:3px solid color-mix(in srgb,var(--danger) 48%,transparent)}
.v7 .mchsline b{font:700 12px/1.3 var(--fd);color:var(--ink)}
.v7 .mchsline span{font:500 10px/1.35 var(--fb);color:var(--muted)}
.v7 .mchsline:active{transform:scale(.99)}
.v7 .protoline{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;margin-top:8px;padding:11px 14px 11px 15px;border-radius:12px;text-decoration:none;background:var(--plate);border:1px solid var(--hair-soft);border-left:3px solid color-mix(in srgb,var(--tide) 68%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.05);font:500 10.5px/1.4 var(--fb);color:var(--muted);transition:transform .2s ease,box-shadow .2s ease}
.v7 .protoline b{font:700 10.5px/1 var(--fb);color:var(--ink)}
.v7 .protoline:hover{transform:translateY(-1px);box-shadow:0 5px 14px -5px rgba(0,0,0,.14)}
.v7 .protoline:active{transform:scale(.99)}
.v7 .reportbtn{display:block;width:100%;text-align:left;margin-top:8px;padding:11px 14px 11px 15px;border-radius:12px;background:var(--plate);border:1px solid var(--hair-soft);border-left:3px solid color-mix(in srgb,var(--amber) 62%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.05);cursor:pointer;font:600 10.5px/1.4 var(--fb);color:var(--ink);font-family:var(--fb);transition:transform .2s ease,box-shadow .2s ease}
.v7 .reportbtn span{color:var(--muted);font-weight:500}
.v7 .reportbtn:hover{transform:translateY(-1px);box-shadow:0 5px 14px -5px rgba(0,0,0,.14)}
.v7 .reportbtn:active{transform:scale(.99)}
/* «Пульс полуострова» — реальные сейсмособытия ритмом */
.v7 .pulse{margin-top:12px;border:1px solid var(--hair);border-radius:14px;padding:13px 14px;background:color-mix(in srgb,var(--plate) 45%,transparent)}
.v7 .pulse .phead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.v7 .pulse .pbig b{font:600 21px/1 var(--fd);letter-spacing:-.02em;display:block}
.v7 .pulse .pbig span{display:block;margin-top:4px;font:400 8.5px/1.3 var(--fm);color:var(--muted)}
.v7 .pulse .psrc{text-align:right;font:600 8px/1.3 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.v7 .pulse .psrc i{display:block;font:400 7.5px/1.4 var(--fm);letter-spacing:.06em;color:var(--faint);text-transform:none;font-style:normal;margin-top:2px;opacity:.85}
.v7 .pulse .pbars{margin-top:12px;display:flex;align-items:flex-end;gap:3px;height:44px}
.v7 .pulse .pbar{flex:1;min-width:0;border:0;padding:0;border-radius:2px;cursor:pointer;opacity:.62;transition:opacity .18s ease,box-shadow .18s ease;transform-origin:bottom}
.v7 .pulse .pbar:hover{opacity:.9}
.v7 .pulse .pbar.on{opacity:1;box-shadow:0 0 0 1.5px var(--bg),0 0 0 3px var(--ink)}
.v7 .pulse .paxis{margin-top:8px;display:flex;justify-content:space-between;font:400 7.5px/1 var(--fm);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.v7 .pulse .psum{margin-top:11px;padding-top:9px;border-top:1px solid var(--hair-soft);font:400 9px/1.4 var(--fm);color:var(--muted)}
.v7 .pulse .psel{margin-top:11px;width:100%;display:flex;align-items:center;gap:10px;text-align:left;background:none;border:0;border-top:1px solid var(--hair-soft);padding:10px 0 0;cursor:pointer;font-family:var(--fb)}
.v7 .pulse .psel .pmag{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font:700 11px/1 var(--fd)}
.v7 .pulse .psel .ptx{display:flex;flex-direction:column;gap:2px}
.v7 .pulse .psel .ptx b{font:500 11px/1.3 var(--fb);color:var(--ink)}
.v7 .pulse .psel .ptx span{font:400 8px/1.3 var(--fm);color:var(--faint)}
/* платы */
.v7 .plates{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:0 -20px;padding:0 20px}
.v7 .plates::-webkit-scrollbar{display:none}
.v7 .plate{flex:none;width:86%;max-width:360px;scroll-snap-align:start}
.v7 .pl-dots{display:flex;gap:7px;justify-content:center;margin-top:14px}
.v7 .pl-dots button{width:6px;height:6px;padding:0;border:0;border-radius:50%;background:var(--hair);cursor:pointer;transition:background .2s,transform .2s}
.v7 .pl-dots button.on{background:var(--shroom);transform:scale(1.25)}
.v7 .plate .img{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--plate) center/cover no-repeat}
.v7 .plate .img::after{content:"";position:absolute;inset:7px;border:1px solid rgba(244,244,240,.35);pointer-events:none}
.v7 .plate .noimg{position:absolute;inset:0;background:linear-gradient(180deg,#7C9E88,#2E5140)}
.v7 .plate .row{display:flex;align-items:baseline;gap:10px;padding:11px 2px 0}
.v7 .plate .row b{font:600 14px/1.25 var(--fd);letter-spacing:-.015em}
.v7 .plate .cap{padding:5px 2px 0;font:400 11px/1.5 var(--fb);color:var(--muted)}
.v7 .plate .buy{margin-top:9px;padding:9px 2px 0;border-top:1px solid var(--hair-soft);display:flex;align-items:baseline;gap:10px}
.v7 .plate .buy .price{font:600 14px/1 var(--fd)}
.v7 .plate .buy .price.muted{color:var(--faint);font-weight:500;font-size:12px}
.v7 .plate .buy a{margin-left:auto;font:700 9.5px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--shroom);border-bottom:1px solid color-mix(in srgb,var(--shroom) 45%,transparent);padding-bottom:3px}
.v7 .arrivals{margin-top:18px;border-top:1px solid var(--hair-soft);padding-top:11px;display:flex;gap:10px;align-items:baseline}
.v7 .arrivals .k{font:600 8.5px/1 var(--fb);letter-spacing:.2em;text-transform:uppercase;color:var(--faint);flex:none}
.v7 .arrivals .t{font:500 11.5px/1.5 var(--fb);color:var(--muted)}
/* проводник */
.v7 .guide{border-left:2px solid var(--pine);padding:2px 0 2px 18px}
.v7 .guide q{display:block;font:500 15px/1.5 var(--fd);letter-spacing:-.01em;quotes:"«" "»"}
.v7 .guide .sig{margin-top:10px;display:flex;align-items:center;gap:10px}
.v7 .guide .sig .caps{font:600 10px/1 var(--fb);letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
.v7 .guide .sig .dot{width:4px;height:4px;border-radius:50%;background:var(--faint)}
.v7 .guide .sig .mono{font:400 9px/1 var(--fm);color:var(--faint)}
.v7 .guide .acts{margin-top:14px;display:flex;gap:22px;align-items:center}
.v7 .guide .acts a{font:600 10px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--pine);border-bottom:1px solid color-mix(in srgb,var(--pine) 35%,transparent);padding-bottom:3px;cursor:pointer}
.v7 .guide .acts a.lead{color:var(--shroom);border-bottom-color:color-mix(in srgb,var(--shroom) 45%,transparent)}
/* стихии — сетка стеклянных плиток (стекло поверх цветного градиента, не сплошного фона) */
.v7 .elements{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.v7 .etile{position:relative;display:block;min-height:110px;border-radius:22px;overflow:hidden;isolation:isolate;
  box-shadow:0 6px 20px rgba(0,0,0,.14);transition:transform .18s,box-shadow .28s}
.v7 .etile::before{content:"";position:absolute;inset:0;z-index:-1}
.v7 .et-fire::before{background:radial-gradient(120% 90% at 30% 15%,#D46A3E 0%,#8A3B28 45%,#3E1710 100%)}
.v7 .et-snow::before{background:radial-gradient(120% 90% at 30% 15%,#DCEAF3 0%,#8FB4CC 45%,#3E5C72 100%)}
.v7 .et-ocean::before{background:radial-gradient(120% 90% at 30% 15%,#7FC1D2 0%,#2E8CA3 45%,#123E4C 100%)}
.v7 .et-therm::before{background:radial-gradient(120% 90% at 30% 15%,#E4CE9E 0%,#B4761F 48%,#5A3B0E 100%)}
.v7 .et-nature::before{background:radial-gradient(120% 90% at 30% 15%,#8FBE6E 0%,#4E8C5B 45%,#234A31 100%)}
.v7 .etile .glass{position:absolute;inset:7px;border-radius:16px;padding:13px 14px;display:flex;flex-direction:column;gap:3px;
  justify-content:flex-end;color:#fff;background:rgba(12,16,15,.24);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  border:1px solid rgba(255,255,255,.20);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.v7 .etile .eicon{color:#fff;margin-bottom:auto;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))}
.v7 .etile b{font:600 14.5px/1.15 var(--fd);letter-spacing:-.01em;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.3)}
.v7 .etile .ecnt{font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .etile:active{transform:scale(.97)}
/* подсветка-свечение по стихии */
.v7 .et-fire{box-shadow:0 8px 24px rgba(180,72,46,.42)}
.v7 .et-snow{box-shadow:0 8px 24px rgba(120,160,190,.42)}
.v7 .et-ocean{box-shadow:0 8px 24px rgba(46,140,163,.45)}
.v7 .et-therm{box-shadow:0 8px 24px rgba(180,118,31,.42)}
.v7 .et-nature{box-shadow:0 8px 24px rgba(78,140,91,.42)}
@media (hover:hover){
  .v7 .etile:hover{transform:translateY(-2px)}
  .v7 .et-fire:hover{box-shadow:0 12px 34px rgba(180,72,46,.62)}
  .v7 .et-snow:hover{box-shadow:0 12px 34px rgba(120,160,190,.62)}
  .v7 .et-ocean:hover{box-shadow:0 12px 34px rgba(46,140,163,.65)}
  .v7 .et-therm:hover{box-shadow:0 12px 34px rgba(180,118,31,.62)}
  .v7 .et-nature:hover{box-shadow:0 12px 34px rgba(78,140,91,.62)}
}
/* цифры */
.v7 .dataline{display:flex;overflow-x:auto;scrollbar-width:none}
.v7 .dataline::-webkit-scrollbar{display:none}
.v7 .dl{flex:none;padding:2px 20px 2px 0;margin-right:20px;border-right:1px solid var(--hair-soft)}
.v7 .dl:last-child{border-right:0;margin-right:0}
.v7 .dl .n{font:600 23px/1 var(--fd);letter-spacing:-.02em}
.v7 .dl .t{margin-top:6px;font:600 8.5px/1.4 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.v7 .dl.link .t{color:var(--tide)}
/* лид */
.v7 .lead{border:1px solid var(--hair);padding:20px 18px}
.v7 .lead h3{font:600 20px/1.22 var(--fd);letter-spacing:-.02em}
.v7 .lead h3 em{font-style:normal;font-weight:800;color:var(--shroom)}
.v7 .lead p{margin-top:9px;font:400 11.5px/1.6 var(--fb);color:var(--muted)}
.v7 .lead .chips{margin-top:14px;display:flex;flex-wrap:wrap;gap:7px}
.v7 .lead .chip{font:600 9.5px/1 var(--fb);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--hair);background:none;padding:8px 11px;cursor:pointer;transition:.15s}
.v7 .lead .chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.v7 .lead .field2{margin-top:14px;display:flex;flex-direction:column;gap:10px}
.v7 .lead .field2>input{border:1px solid var(--hair);background:var(--field);padding:14px 13px;font:500 13px/1 var(--fb);color:var(--ink);outline:none}
.v7 .lead .field{display:flex;border:1px solid var(--hair);background:var(--field)}
.v7 .lead .field input{flex:1;border:0;background:none;padding:14px 13px;font:500 13px/1 var(--fb);color:var(--ink);outline:none}
.v7 .lead .field input::placeholder,.v7 .lead .field2>input::placeholder{color:var(--faint)}
.v7 .lead .field button{border:0;background:var(--shroom);color:#fff;font:700 10px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;padding:0 18px;cursor:pointer}
.v7 .lead .field button:disabled{opacity:.6}
.v7 .lead .err{margin-top:10px;font:500 11px/1.4 var(--fb);color:var(--danger)}
.v7 .lead .fine{margin-top:9px;font:400 8.5px/1.5 var(--fm);color:var(--faint)}
.v7 .lead .ok{margin-top:14px;padding:12px;border:1px solid color-mix(in srgb,var(--pine) 40%,transparent);font:500 12px/1.5 var(--fb);color:var(--pine);display:none}
.v7 .lead.sent .ok{display:block}
.v7 .lead.sent .field2,.v7 .lead.sent .chips,.v7 .lead.sent .fine,.v7 .lead.sent .err{display:none}
/* хабы */
.v7 .hubline{display:flex;flex-wrap:wrap;gap:12px 24px}
.v7 .hubline a{font:600 10.5px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);padding-bottom:4px;border-bottom:1px solid transparent}
.v7 .hubline a:active{color:var(--ink);border-bottom-color:var(--ink)}
.v7 .note{margin:40px 0 8px;padding-top:12px;border-top:1px solid var(--hair);font:400 9px/1.7 var(--fm);color:var(--faint)}
/* навигация */
.v7 nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:50;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2);border-top:1px solid var(--hair)}
.v7 nav.tabs .in{max-width:480px;margin:0 auto;display:flex;padding:0 4px}
.v7 nav.tabs a,.v7 nav.tabs button{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 0 calc(7px + env(safe-area-inset-bottom));color:var(--faint);font:600 8px/1 var(--fb);letter-spacing:.06em;text-transform:uppercase;transition:color .22s ease;background:none;border:0;cursor:pointer}
.v7 nav.tabs a .ico,.v7 nav.tabs button .ico{display:flex;align-items:center;justify-content:center;width:46px;height:28px;border-radius:999px;transition:background .28s cubic-bezier(.22,1,.36,1),transform .18s ease}
.v7 nav.tabs a .ti,.v7 nav.tabs button .ti{transition:transform .28s cubic-bezier(.22,1,.36,1),color .22s ease}
.v7 nav.tabs a:active .ico,.v7 nav.tabs button:active .ico{transform:scale(.9)}
.v7 nav.tabs a.active{color:var(--ink)}
.v7 nav.tabs a.active .ico{background:color-mix(in srgb,var(--shroom) 15%,transparent)}
.v7 nav.tabs a.active .ti{color:var(--shroom);transform:translateY(-1px)}
.v7 nav.tabs .sos-tab{color:var(--danger)}
.v7 nav.tabs .sos-tab .ico{background:var(--danger);box-shadow:0 3px 12px color-mix(in srgb,var(--danger) 38%,transparent)}
.v7 nav.tabs .sos-tab .ti{color:#fff}
/* SOS — красный */
.v7 .sos{position:fixed;right:18px;bottom:78px;z-index:55;width:58px;height:58px;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--danger);color:#fff;font:700 13px/1 var(--fb);letter-spacing:.12em;text-decoration:none;cursor:pointer;box-shadow:0 6px 22px color-mix(in srgb,var(--danger) 40%,transparent)}
/* Инлайн-панель экстренной помощи (офлайн-стойкая, поверх главной) */
.v7 .emg{position:fixed;inset:0;z-index:100;background:var(--bg);display:flex;flex-direction:column;animation:emgin .18s ease}
@keyframes emgin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.v7 .emg-top{display:flex;align-items:center;justify-content:space-between;padding:16px 18px calc(14px);border-bottom:1px solid var(--hair);padding-top:calc(16px + env(safe-area-inset-top))}
.v7 .emg-top b{font:700 17px/1 var(--fd);color:var(--ink)}
.v7 .emg-x{width:38px;height:38px;display:grid;place-items:center;background:none;border:0;color:var(--muted);cursor:pointer}
.v7 .emg-scroll{flex:1;overflow-y:auto;padding:16px 18px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:18px}
.v7 .emg-lbl{display:flex;align-items:center;gap:6px;font:600 9px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.v7 .emg-coord{display:flex;flex-direction:column;gap:8px}
.v7 .emg-cval{align-self:flex-start;display:inline-flex;align-items:center;gap:10px;font:600 20px/1 var(--fm);color:var(--ink);background:none;border:0;padding:0;cursor:pointer;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.v7 .emg-cval span{font:600 8.5px/1 var(--fb);letter-spacing:.12em;text-transform:uppercase;color:var(--tide)}
.v7 .emg-cwait{font:500 13px/1.3 var(--fb);color:var(--muted)}
.v7 .emg-calls{display:flex;flex-direction:column;gap:9px}
.v7 .emg-call{display:flex;align-items:center;gap:12px;padding:13px 15px;border-radius:14px;border:1px solid var(--hair);background:var(--plate);color:var(--ink);text-decoration:none}
.v7 .emg-call .emg-ct{display:flex;flex-direction:column;gap:2px}
.v7 .emg-call .emg-ct b{font:600 15px/1 var(--fb)}
.v7 .emg-call .emg-ct span{font:400 10px/1.2 var(--fb);color:var(--muted)}
.v7 .emg-call-primary{background:var(--danger);border-color:transparent;color:#fff;padding:17px 18px}
.v7 .emg-call-primary .emg-ct b{font:800 26px/1 var(--fd);letter-spacing:.02em}
.v7 .emg-call-primary .emg-ct span{color:rgba(255,255,255,.85)}
.v7 .emg-sms{display:block;text-align:center;padding:12px;border-radius:12px;border:1px dashed var(--hair);color:var(--tide);font:600 11px/1 var(--fb);letter-spacing:.06em;text-transform:uppercase;text-decoration:none}
.v7 .emg-protos{display:flex;flex-direction:column;gap:8px}
.v7 .emg-proto{border:1px solid var(--hair);border-radius:12px;overflow:hidden}
.v7 .emg-phead{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--plate);border:0;cursor:pointer;text-align:left;font-family:var(--fb)}
.v7 .emg-pt{display:flex;flex-direction:column;gap:3px}
.v7 .emg-pt b{font:600 13px/1 var(--fb);color:var(--ink)}
.v7 .emg-pt span{font:400 10px/1.3 var(--fb);color:var(--danger)}
.v7 .emg-chev{color:var(--muted);flex:none;transition:transform .2s ease}
.v7 .emg-chev-on{transform:rotate(180deg)}
.v7 .emg-steps{margin:0;padding:6px 16px 14px 30px;display:flex;flex-direction:column;gap:7px;list-style:decimal}
.v7 .emg-steps li{font:400 12px/1.45 var(--fb);color:var(--ink)}
.v7 .emg-note{font:400 10.5px/1.4 var(--fm);color:var(--faint);text-align:center;margin:2px 0 0}
.v7 .sos:active{transform:scale(.94)}
`;
