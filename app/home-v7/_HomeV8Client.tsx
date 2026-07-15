'use client';

/**
 * Главная v8 «Воронка» (превью, /home-v7) — фото-первый герой + честные приборы.
 * Отличия от v7-прототипа (по договорённости с владельцем):
 *   - Герой на реальном фото Камчатки, не на градиенте-заглушке.
 *   - Блок безопасности — реальные данные: KVERT ACC (volcano_status) +
 *     лента external_alerts. Фейковой сейсмоленты и компаса нет.
 *   - Платы — реальные туры/маршруты с фото и ценой (queryCatalog).
 *   - Лид-форма шлёт реальный POST /api/leads (lead-processor).
 *   - SOS окрашен в --danger, отдельно от коммерческой оранжевой.
 *   - Эко-баллы не показываем: начисление в коде не подключено (нечестно).
 * Данные приходят из серверного data-слоя (app/home-v7/data.ts).
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Flame, Snowflake, Waves, Droplets, Trees, type LucideIcon } from 'lucide-react';
import type { HomeV8Data } from './data';

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

function magColor(m: number): string {
  if (m >= 6) return 'var(--brusnika)';
  if (m >= 4.5) return 'var(--shroom)';
  if (m >= 3) return 'var(--amber)';
  return 'var(--tide)';
}
const SRC_LABEL: Record<string, string> = { kbgsras: 'КБГС РАН', usgs: 'USGS', none: '' };

export default function HomeV8Client({ data, preview = false }: { data: HomeV8Data; preview?: boolean }) {
  const { safety, seismic, radar, zones, plates, feed, stats, elements } = data;
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [chips, setChips] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sosOpen, setSosOpen] = useState(false);
  const [hold, setHold] = useState(0); // 0..1 для дуги удержания
  const [plateIdx, setPlateIdx] = useState(0);
  const leadRef = useRef<HTMLDivElement | null>(null);
  const platesRef = useRef<HTMLDivElement | null>(null);
  const holdRaf = useRef<number | null>(null);
  const holdT0 = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-v7theme', theme);
    return () => document.documentElement.removeAttribute('data-v7theme');
  }, [theme]);

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

  // SOS: удержание 1с → открыть шторку
  const HOLD_MS = 1000;
  const startHold = (e: React.PointerEvent) => {
    e.preventDefault();
    holdT0.current = null;
    const tick = (ts: number) => {
      if (holdT0.current == null) holdT0.current = ts;
      const k = Math.min(1, (ts - holdT0.current) / HOLD_MS);
      setHold(k);
      if (k >= 1) { setSosOpen(true); resetHold(); return; }
      holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
  };
  const resetHold = () => {
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    holdRaf.current = null; holdT0.current = null; setHold(0);
  };

  const openZones = zones.total > 0 ? zones.open : null;
  const heroImg = theme === 'dark' ? '/images/hero/hero-dark.jpeg' : '/images/hero/hero-light.jpeg';

  return (
    <div className="v7 v8" id="v8root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* панель темы (в превью — с меткой) */}
      <div className="protobar">
        <span className="tag">{preview ? 'Превью · v8 «Воронка»' : ''}</span>
        <div className="seg" id="themeSeg">
          <button aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Днём</button>
          <button aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>В поле</button>
        </div>
      </div>

      {/* шапка */}
      <div className="topbar"><div className="in">
        <span className="brand">Ведар</span>
        <span className="sp" />
        <button className="icn" aria-label="Поиск">
          <svg viewBox="0 0 24 24" className="li"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
        <button className="cta-top" onClick={jumpToLead}>Хочу тур</button>
      </div></div>

      {/* ГЕРОЙ — фото-первый */}
      <header className="hero-photo" style={{ backgroundImage: `linear-gradient(180deg, rgba(10,14,12,.15) 0%, rgba(10,14,12,.55) 62%, rgba(10,14,12,.82) 100%), url('${heroImg}')` }}>
        <div className="hero-in">
          <div className="dateline"><span>Камчатка · живая сводка</span></div>
          <h1>Полуостров,<br />прочитанный <em>сегодня</em></h1>
          <p className="sub">Маршруты, безопасность и реальные туры проверенных операторов — в одном месте.</p>

          {/* честное кольцо: открыто N из M зон (реальные данные) */}
          <div className="ring-glass">
            {openZones != null ? (
              <>
                <Ring open={zones.open} total={zones.total} />
                <div className="ring-cap">
                  <b>{zones.open}<i>/{zones.total}</i></b>
                  <span>зон открыто сегодня</span>
                  {zones.updatedAt && <em>обновлено {fmtAgo(zones.updatedAt)}</em>}
                </div>
              </>
            ) : (
              <div className="ring-cap"><span>Статусы зон обновляются</span></div>
            )}
          </div>

          <button className="cta-hero" onClick={jumpToLead}>Подобрать тур</button>
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
          <div className="shead"><span className="num">I</span><h2>Радар безопасности</h2><span className="line" /><Link className="all" href="/map">Карта</Link></div>

          <RadarScope hazards={radar.hazards} center={radar.center} />

          {(safety.alerts.length > 0 || seismic.events.length > 0) && (
            <div className="safety">
              {safety.alerts.length > 0 && (
                <ul className="alerts">
                  {safety.alerts.map((a, i) => (
                    <li key={i}>
                      <i className={a.severity >= 3 ? 'sev-hi' : a.severity === 2 ? 'sev-mid' : 'sev-lo'} />
                      <span className="atx">{a.title}</span>
                      <span className="ago">{fmtAgo(a.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
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
            <div className="shead"><span className="num">II</span><h2>Куда сегодня</h2><span className="line" /><Link className="all" href="/routes">Все</Link></div>
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
          <div className="shead"><span className="num">III</span><h2>Проводник Кузьмич</h2><span className="line" /></div>
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
            <div className="shead"><span className="num">IV</span><h2>Стихии</h2><span className="line" /><Link className="all" href="/routes">Все места</Link></div>
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
          <div className="shead"><span className="num">V</span><h2>В цифрах</h2><span className="line" /></div>
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
          <div className="shead"><span className="num">VI</span><h2>Собрать поездку</h2><span className="line" /></div>
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
          <div className="shead"><span className="num">VII</span><h2>Разделы</h2><span className="line" /></div>
          <div className="hubline">
            <Link href="/routes">Туристам</Link><Link href="/routes?activity_type=fishing">Рыбалка</Link>
            <Link href="/hub">Операторам</Link><Link href="/guides">Гидам</Link>
            <Link href="/accommodations">Жильё</Link><Link href="/gear">Снаряжение</Link><Link href="/transfers">Трансферы</Link>
          </div>
        </section>

        {preview && (
          <div className="note">
            Превью Главной v8 на /home-v7. Живые блоки на реальных данных: безопасность — KVERT (volcano_status)
            и external_alerts; сейсмособытия — КБГС РАН / USGS (общий слой seismic-feed); кольцо —
            location_real_time_status; платы — queryCatalog; лид-форма — POST /api/leads. Фейкового компаса и
            не подключённых эко-баллов нет — только настоящие данные.
          </div>
        )}
      </div>

      {/* SOS — красный, отдельно от коммерции */}
      <button className="sos" aria-label="SOS — удерживайте"
        onPointerDown={startHold} onPointerUp={resetHold} onPointerLeave={resetHold} onPointerCancel={resetHold}>
        SOS
        <svg className="hold" viewBox="0 0 72 72"><circle cx="36" cy="36" r="34" style={{ strokeDashoffset: 213 * (1 - hold) }} /></svg>
      </button>
      <div className={`scrim${sosOpen ? ' on' : ''}`} onClick={() => setSosOpen(false)} />
      <div className={`sheet${sosOpen ? ' on' : ''}`} role="dialog" aria-label="Экстренная помощь">
        <h3>Что случилось?</h3>
        <p>Категория уйдёт спасателям вместе с координатами. Работает офлайн — SMS-канал.</p>
        <div className="protocols">
          <button className="proto" onClick={() => setSosOpen(false)}><b>Потерялся</b><span>маяк + последняя точка</span></button>
          <button className="proto" onClick={() => setSosOpen(false)}><b>Медведь</b><span>протокол встречи</span></button>
          <button className="proto" onClick={() => setSosOpen(false)}><b>Травма</b><span>помощь + вызов SAR</span></button>
          <button className="proto" onClick={() => setSosOpen(false)}><b>Холод</b><span>гипотермия офлайн</span></button>
        </div>
        <a className="call112" href="tel:112">Позвонить 112</a>
      </div>

      {/* нижняя навигация */}
      <nav className="tabs"><div className="in">
        <Link href="/" className="active">Дом</Link>
        <Link href="/map">Карта</Link>
        <Link href="/kuzmich">Кузьмич</Link>
        <Link href="/routes">Маршруты</Link>
        <Link href="/safety" className="sos-tab">СОС</Link>
      </div></nav>
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

/** Кольцо готовности: дуга открытых зон (зелёная) на фоне закрытых (красная). Реальные open/total. */
function Ring({ open, total }: { open: number; total: number }) {
  const N = Math.max(total, 1);
  const cx = 92, cy = 92, r = 78, gap = 4;
  const seg = 360 / N - gap;
  const P = (a: number): [number, number] => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const arcs = Array.from({ length: N }, (_, i) => {
    const a0 = i * (360 / N) + gap / 2, a1 = a0 + seg;
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    const col = i < open ? 'var(--pine)' : 'var(--brusnika)';
    return <path key={i} d={`M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`} stroke={col} strokeWidth={4} strokeLinecap="round" fill="none" />;
  });
  return <svg className="dial" viewBox="0 0 184 184">{arcs}</svg>;
}

const CSS = `
.v7{
  --fd:var(--font-unbounded),system-ui,sans-serif;--fb:var(--font-manrope),system-ui,sans-serif;--fm:var(--font-jetbrains),ui-monospace,monospace;
  --pine:#2E5F46;--tide:#3E8CA3;--brusnika:#B23A32;--amber:#B4761F;--shroom:#D97B2E;--leaf:#4E8C5B;--danger:#C0392B;
}
html[data-v7theme="light"] .v7,.v7[data-v7theme="light"]{--bg:#F4F4F0;--ink:#1D2724;--muted:#66736E;--faint:#9AA5A0;--hair:rgba(29,39,36,.14);--hair-soft:rgba(29,39,36,.08);--plate:#EBECE6;--field:#FFFFFF}
html[data-v7theme="dark"] .v7,.v7[data-v7theme="dark"]{--bg:#111715;--ink:#EAEDEA;--muted:#93A09A;--faint:#5C6863;--hair:rgba(234,237,234,.16);--hair-soft:rgba(234,237,234,.08);--plate:#18201D;--field:#1A211E}
.v7,.v7[data-v7theme]{--bg:#F4F4F0;--ink:#1D2724;--muted:#66736E;--faint:#9AA5A0;--hair:rgba(29,39,36,.14);--hair-soft:rgba(29,39,36,.08);--plate:#EBECE6;--field:#FFFFFF}
.v7 *{margin:0;padding:0;box-sizing:border-box}
.v7{font-family:var(--fb);background:var(--bg);color:var(--ink);min-height:100dvh;padding-bottom:96px;-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){.v7 *,.v7 *::before,.v7 *::after{animation:none!important;transition:none!important}}
.v7 .wrap{max-width:480px;margin:0 auto;padding:0 20px}
.v7 .li{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;display:block}
.v7 a{color:inherit;text-decoration:none}
.v7 .protobar{position:sticky;top:0;z-index:60;background:var(--bg);border-bottom:1px solid var(--hair);padding:9px 14px;display:flex;gap:10px;align-items:center}
.v7 .protobar .tag{font:400 9px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-right:auto}
.v7 .seg{display:flex;gap:14px}
.v7 .seg button{font:600 10px/1 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);background:none;border:0;padding:4px 0;cursor:pointer;border-bottom:1px solid transparent}
.v7 .seg button[aria-pressed="true"]{color:var(--ink);border-bottom-color:var(--ink)}
.v7 .topbar{position:sticky;top:39px;z-index:55;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--hair)}
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
.v7 .ring-glass{margin:20px auto 0;display:flex;align-items:center;gap:16px;justify-content:center;backdrop-filter:blur(10px);background:rgba(10,14,12,.32);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:14px 18px;width:max-content;max-width:100%}
.v7 .ring-glass .dial{width:84px;height:84px;transform:rotate(-90deg);flex:none}
.v7 .ring-cap{text-align:left}
.v7 .ring-cap b{font:700 23px/1 var(--fd);letter-spacing:-.02em}
.v7 .ring-cap b i{font-style:normal;color:rgba(255,255,255,.6);font-size:16px}
.v7 .ring-cap span{display:block;font:600 9px/1.4 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.82);margin-top:3px}
.v7 .ring-cap em{display:block;font:400 8.5px/1.4 var(--fm);color:rgba(255,255,255,.6);margin-top:3px;font-style:normal}
.v7 .cta-hero{margin-top:20px;background:var(--shroom);color:#fff;border:0;font:700 12px/1 var(--fb);letter-spacing:.16em;text-transform:uppercase;padding:15px 30px;cursor:pointer;transition:transform .13s}
.v7 .cta-hero:active{transform:scale(.97)}
.v7 .hero-photo .kvert{margin-top:14px;display:inline-flex;align-items:center;gap:8px;font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .hero-photo .kvert i{width:7px;height:7px;border-radius:50%}
/* секции */
.v7 section{margin-top:40px}
.v7 .shead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.v7 .shead .num{font:500 11px/1 var(--fm);color:var(--faint)}
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
.v7 .alerts{list-style:none}
.v7 .alerts li{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--hair-soft)}
.v7 .alerts li:first-child{border-top:0}
.v7 .alerts li i{width:6px;height:6px;border-radius:50%;flex:none;align-self:center}
.v7 .alerts i.sev-hi{background:var(--brusnika)}.v7 .alerts i.sev-mid{background:var(--amber)}.v7 .alerts i.sev-lo{background:var(--tide)}
.v7 .alerts .atx{font:500 12px/1.45 var(--fb);flex:1}
.v7 .alerts .ago{font:400 8.5px/1 var(--fm);color:var(--faint);white-space:nowrap}
.v7 .safety .src{margin-top:12px;padding-top:10px;border-top:1px solid var(--hair-soft);font:400 8.5px/1.4 var(--fm);color:var(--faint)}
/* «Пульс полуострова» — реальные сейсмособытия ритмом */
.v7 .pulse{margin-top:14px;border:1px solid var(--hair);border-radius:14px;padding:14px 15px}
.v7 .pulse .phead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.v7 .pulse .pbig b{font:700 30px/0.95 var(--fd);letter-spacing:-.02em;display:block}
.v7 .pulse .pbig span{display:block;margin-top:4px;font:400 9px/1.3 var(--fm);color:var(--muted)}
.v7 .pulse .psrc{text-align:right;font:600 8.5px/1.3 var(--fb);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.v7 .pulse .psrc i{display:block;font:400 8px/1.4 var(--fm);letter-spacing:.08em;color:var(--faint);text-transform:none;font-style:normal;margin-top:2px}
.v7 .pulse .pbars{margin-top:14px;display:flex;align-items:flex-end;gap:4px;height:70px}
.v7 .pulse .pbar{flex:1;min-width:0;border:0;padding:0;border-radius:3px 3px 0 0;cursor:pointer;opacity:.85;transition:opacity .15s,transform .15s;transform-origin:bottom}
.v7 .pulse .pbar:hover{opacity:1}
.v7 .pulse .pbar.on{opacity:1;transform:scaleX(1.15);outline:2px solid var(--ink);outline-offset:1px}
.v7 .pulse .paxis{margin-top:6px;display:flex;justify-content:space-between;font:400 8px/1 var(--fm);letter-spacing:.08em;color:var(--faint)}
.v7 .pulse .psum{margin-top:12px;padding-top:10px;border-top:1px solid var(--hair-soft);font:400 9.5px/1.4 var(--fm);color:var(--muted)}
.v7 .pulse .psel{margin-top:12px;width:100%;display:flex;align-items:center;gap:11px;text-align:left;background:none;border:0;border-top:1px solid var(--hair-soft);padding:11px 0 0;cursor:pointer;font-family:var(--fb)}
.v7 .pulse .psel .pmag{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font:700 12px/1 var(--fd)}
.v7 .pulse .psel .ptx{display:flex;flex-direction:column;gap:2px}
.v7 .pulse .psel .ptx b{font:500 11.5px/1.3 var(--fb);color:var(--ink)}
.v7 .pulse .psel .ptx span{font:400 8.5px/1.3 var(--fm);color:var(--faint)}
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
.v7 nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:50;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(16px);border-top:1px solid var(--hair)}
.v7 nav.tabs .in{max-width:480px;margin:0 auto;display:flex}
.v7 nav.tabs a{flex:1;display:flex;align-items:center;justify-content:center;padding:14px 0 calc(13px + env(safe-area-inset-bottom));color:var(--faint);font:600 8.5px/1 var(--fb);letter-spacing:.18em;text-transform:uppercase}
.v7 nav.tabs a.active{color:var(--ink)}
.v7 nav.tabs a.sos-tab{color:var(--danger)}
/* SOS — красный */
.v7 .sos{position:fixed;right:18px;bottom:78px;z-index:55;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:var(--danger);color:#fff;font:700 13px/1 var(--fb);letter-spacing:.12em;box-shadow:0 6px 22px color-mix(in srgb,var(--danger) 40%,transparent);touch-action:none;user-select:none;-webkit-user-select:none}
.v7 .sos svg.hold{position:absolute;inset:-6px}
.v7 .sos circle{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-dasharray:213;transform:rotate(-90deg);transform-origin:center;transition:stroke-dashoffset .05s linear}
.v7 .scrim{position:fixed;inset:0;background:rgba(17,23,21,.5);z-index:70;opacity:0;pointer-events:none;transition:opacity .25s}
.v7 .scrim.on{opacity:1;pointer-events:auto}
.v7 .sheet{position:fixed;left:0;right:0;bottom:0;z-index:71;transform:translateY(105%);transition:transform .32s cubic-bezier(.3,.9,.3,1);background:var(--bg);border-top:1px solid var(--hair);padding:18px 22px calc(22px + env(safe-area-inset-bottom));max-width:480px;margin:0 auto}
.v7 .sheet.on{transform:none}
.v7 .sheet h3{font:600 17px/1.2 var(--fd);letter-spacing:-.02em}
.v7 .sheet p{font:400 11.5px/1.6 var(--fb);color:var(--muted);margin-top:6px}
.v7 .protocols{margin-top:16px}
.v7 .proto{width:100%;display:flex;align-items:center;gap:14px;padding:13px 2px;border:0;border-bottom:1px solid var(--hair-soft);background:none;cursor:pointer;color:var(--ink);text-align:left;font-family:var(--fb)}
.v7 .proto:first-child{border-top:1px solid var(--hair-soft)}
.v7 .proto b{font:600 14px/1.2 var(--fd)}
.v7 .proto span{font:400 10px/1.4 var(--fb);color:var(--muted);margin-left:auto;text-align:right}
.v7 .call112{display:block;text-align:center;margin-top:16px;width:100%;padding:15px;border:0;cursor:pointer;background:var(--danger);color:#fff;font:700 12px/1 var(--fb);letter-spacing:.2em;text-transform:uppercase}
`;
