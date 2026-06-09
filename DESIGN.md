# Design

## Visual Identity

Warm, volcanic earth tones grounded in Kamchatka's landscape: lava rock, dried tundra, ash grey, deep ocean. Not cold or minimal. Not tropical. The palette reads like late-afternoon light on a volcanic plateau.

Dark mode is primary for on-trail use (battery, sunlight readability). Light mode for planning and discovery.

## Color Tokens

All colors are defined as CSS custom properties in `app/globals.css`. Never use hardcoded hex values — always reference the token.

### Core palette (light / dark)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg-primary` | `#F5F0EB` | `#0D1117` | Page background |
| `--bg-card` | `#FFFFFF` | `#21262D` | Card surfaces |
| `--bg-hover` | `#F0ECE7` | `#30363D` | Hover state |
| `--text-primary` | `#1A1714` | `#F0F6FC` | Headings, body |
| `--text-secondary` | `#6B6560` | `#8B949E` | Labels, captions |
| `--text-muted` | `#9A9590` | `#484F58` | Placeholders, disabled |
| `--border` | `rgba(0,0,0,0.07)` | `rgba(255,255,255,0.08)` | Borders, dividers |

### Brand accent tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent` | `#D44A0C` | `#E8734A` | CTA, active states, links |
| `--ocean` | `#2568B0` | `#00A8CC` | Map, navigation, icons |
| `--success` | `#3FB950` | `#3FB950` | Eco points, completion |
| `--warning` | `#D29922` | `#D29922` | Weather alerts, caution |
| `--danger` | `#DC2626` | `#F85149` | SOS, errors, critical |

### Prohibited

- `bg-white`, `bg-black`, `text-white`, `text-black` — use token equivalents
- `bg-white/10`, `backdrop-blur-*` — glassmorphism is banned
- Hardcoded hex anywhere in components
- `text-cyber-cyan`, `text-premium-gold`, `bg-premium-*` — legacy, do not use
- `rounded-2xl` — use `rounded-lg`
- `font-black` — use `font-bold`

## Typography

Two typefaces only.

**Display: Playfair Display** (`--font-playfair`, `font-playfair` Tailwind class)
- Headlines, section titles, hero text, place names
- Use at `text-3xl` and above
- Communicates heritage, authority, permanence

**Body: Outfit** (`--font-outfit`, default body font)
- All UI text, labels, descriptions, navigation
- Clean, modern, readable at small sizes

### Scale rules

- Body line length: 60–70ch max
- Hierarchy ratio: ≥1.25× between adjacent steps
- Hero/display ceiling: `clamp(2.5rem, 6vw, 4.5rem)` — do not exceed
- `text-wrap: balance` on h1–h3
- No all-caps body copy

## Component Library

Utility classes defined in `globals.css`:

| Class | Description |
|---|---|
| `ds-page` | Page wrapper with padding and max-width |
| `ds-card` | White/dark card with border, subtle shadow, `rounded-lg` |
| `ds-section` | Section spacing utility |
| `ds-input` | Form input — border, focus ring using `--accent` |
| `ds-btn` | Base button — padding, radius, font |
| `ds-btn-primary` | Filled button in `--accent` |
| `ds-btn-secondary` | Outlined/ghost button |
| `ds-btn-danger` | Filled button in `--danger` |
| `ds-badge` | Small status badge |
| `ds-skeleton` | Loading placeholder shimmer |
| `ds-h1`, `ds-h2` | Semantic heading styles with Playfair |
| `ds-label` | Form label style |

## Layout

- Container: `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`
- Cards grid: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4` (or `gap-6`)
- Responsive grids without breakpoints: `repeat(auto-fit, minmax(280px, 1fr))`
- Nested cards: **forbidden**
- `rounded-lg` everywhere, never `rounded-2xl`

## Iconography

Lucide React only. No emoji in UI. No other icon libraries. Size: 14–24px depending on context.

## Motion

- Tailwind transition utilities only: `transition-all duration-200`, `transition-colors`, `transition-opacity`
- No `@keyframes` in component files
- Reduced motion: every animated element needs `@media (prefers-reduced-motion: reduce)` alternative
- No bounce, no elastic easing
- framer-motion is available for complex DnD (planner only)

## Key Surfaces

### Homepage (`app/page.tsx`)
Full-bleed hero → MoodEntry (6 tiles) → BentoGrid → LiveFeed → ActivityCircles → CTASection. Mobile: pill nav bar (Дом / Карта / Избранное / ЛК / SOS).

### Place card (`/places/[id]`)
Hero gallery → title + coordinates → status strip → description → safety facts → routes → map → Kуzmich → reviews → nearby tours → nearby places.

### Route card (`/routes/[id]`)
Map with track → stats row → description → waypoints list → hazards → МЧС prep → GPX download → Kуzmich → reviews.

### Planner (`/planner`)
Multi-day trip builder. framer-motion DnD. Days, activities, budget breakdown. Share token.

### Hub (`/hub/*`)
Dashboard register. Sidebar nav. Data-dense tables. Operator, tourist, admin sub-hubs.

## Photography & Imagery

- Source: `public/images/` — real Kamchatka photography
- No placeholder.com, no Unsplash URLs
- Fallback for missing photos: `RouteGradientPlaceholder` component (gradient by `location_type`)
- Hero images: `object-cover`, `aspect-video` or fixed height
- Always lazy-load non-hero images

## Anti-patterns (impeccable rules applied to this codebase)

- No glassmorphism (`backdrop-blur`, semi-transparent cards)
- No gradient overlays on text — use `text-[var(--text-primary)]` with solid backgrounds
- No card nesting (card inside card)
- No arbitrary z-index values (999, 9999)
- No `font-black` — `font-bold` is the maximum
- No more than 2 font families in any single component
- No marketing buzzwords in copy (seamless, powerful, revolutionary)
- No `SELECT *` on large tables — always name columns
