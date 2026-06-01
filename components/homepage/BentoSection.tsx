import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

interface Cell {
  img: string;
  tag: string;
  title: string;
  sub: string;
  href: string;
}

const CELLS: Cell[] = [
  {
    img: '/images/bento/mutnovsky.jpg',
    tag: 'Вулканы',
    title: 'Мутновский',
    sub: '29 вулканов · действующий',
    href: '/map?type=volcano',
  },
  {
    img: '/images/bento/cape.jpg',
    tag: 'Побережье',
    title: 'Мысы и бухты',
    sub: 'Тихоокеанское побережье',
    href: '/map?type=bay',
  },
  {
    img: '/images/bento/paratunka.jpg',
    tag: 'Термальные',
    title: 'Паратунка',
    sub: '90+ горячих источников',
    href: '/map?type=hot_spring',
  },
  {
    img: '/images/bento/khalaktyr.jpg',
    tag: 'Пляжи',
    title: 'Халактырский пляж',
    sub: 'Чёрный вулканический песок',
    href: '/map?type=beach',
  },
  {
    img: '/images/bento/laguna.jpg',
    tag: 'Озёра',
    title: 'Голубая лагуна',
    sub: '50+ озёр на полуострове',
    href: '/map?type=lake',
  },
];

function BentoCell({ img, tag, title, sub, href }: Cell) {
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-sm block h-full transition-shadow duration-700"
      style={{ boxShadow: '0 4px 24px -8px rgba(0,0,0,0.18)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 16px 40px -10px rgba(212,74,12,0.22), 0 4px 16px -4px rgba(0,0,0,0.25)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 24px -8px rgba(0,0,0,0.18)'; }}
    >
      <img
        src={img}
        alt={title}
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
        loading="lazy"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent transition-opacity duration-700 group-hover:opacity-90" />
      <div className="absolute top-3.5 right-3.5 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
        <div className="bg-[var(--accent)] rounded-full p-1.5">
          <ArrowUpRight size={12} className="text-white" />
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 p-4 md:p-5 translate-y-1 group-hover:translate-y-0 transition-transform duration-500">
        <p className="text-[9px] uppercase tracking-[0.3em] text-white/60 font-semibold mb-1.5">
          {tag}
        </p>
        <p
          className="font-playfair italic text-white font-bold leading-tight mb-1"
          style={{ fontSize: 'clamp(1rem, 2vw, 1.4rem)' }}
        >
          {title}
        </p>
        <p className="text-white/55 text-[11px] opacity-0 group-hover:opacity-100 transition-opacity duration-500">{sub}</p>
      </div>
    </Link>
  );
}

export function BentoSection() {
  return (
    <section className="max-w-7xl mx-auto px-4 md:px-8 py-16 md:py-24">

      <div className="flex items-end justify-between mb-10 md:mb-12">
        <div>
          <div className="w-8 h-px bg-[var(--accent)] mb-5" />
          <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-semibold mb-3">
            778 точек на карте
          </p>
          <h2
            className="font-playfair font-bold text-[var(--text-primary)] leading-[1.05]"
            style={{ fontSize: 'clamp(2rem, 4vw, 3.25rem)' }}
          >
            Знай что там<br />
            <em className="italic text-[var(--accent)]">на самом деле</em>
          </h2>
        </div>
        <Link
          href="/map"
          className="hidden md:flex items-center gap-1.5 text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors duration-300 shrink-0 ml-8"
        >
          Вся карта
          <ArrowUpRight size={15} />
        </Link>
      </div>

      {/* Mobile: 2-col stacked */}
      <div className="md:hidden grid grid-cols-2 gap-2">
        <div className="col-span-2 h-52"><BentoCell {...CELLS[0]} /></div>
        <div className="h-40"><BentoCell {...CELLS[1]} /></div>
        <div className="h-40"><BentoCell {...CELLS[2]} /></div>
        <div className="h-40"><BentoCell {...CELLS[3]} /></div>
        <div className="h-40"><BentoCell {...CELLS[4]} /></div>
      </div>

      {/* Desktop: asymmetric bento */}
      <div
        className="hidden md:grid gap-2.5"
        style={{
          gridTemplateColumns: 'repeat(3, 1fr)',
          gridTemplateRows: '270px 270px 180px',
        }}
      >
        <div style={{ gridColumn: '1', gridRow: '1 / 3' }}>
          <BentoCell {...CELLS[0]} />
        </div>
        <div style={{ gridColumn: '2', gridRow: '1' }}>
          <BentoCell {...CELLS[1]} />
        </div>
        <div style={{ gridColumn: '3', gridRow: '1' }}>
          <BentoCell {...CELLS[2]} />
        </div>
        <div style={{ gridColumn: '2 / 4', gridRow: '2' }}>
          <BentoCell {...CELLS[3]} />
        </div>
        <div style={{ gridColumn: '1 / 4', gridRow: '3' }}>
          <BentoCell {...CELLS[4]} />
        </div>
      </div>
    </section>
  );
}
