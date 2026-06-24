# make-interfaces-feel-better

A systematic approach to refining interfaces through intentional detail work across typography, surfaces, animations, and performance.

## When to use this skill

Use this skill when:
- Building new UI components that need polish
- Reviewing existing components for quality issues
- A design looks "almost right" but something feels off

## Core Principles

### 1. Concentric Border Radius
```
outerRadius = innerRadius + padding
```
Nested rounded elements must follow this formula. If padding > 24px, treat as separate surfaces.

### 2. Optical Over Geometric Alignment
- Button with icon: icon-side padding = text-side padding - 2px
- Play button triangle: shift right 2px
- Asymmetric icons: fix in SVG or use margin-left: 1px

### 3. Shadows Instead of Borders
Replace borders on cards/buttons with layered box-shadow:
```css
--shadow-border:
  0px 0px 0px 1px rgba(0, 0, 0, 0.06),
  0px 1px 2px -1px rgba(0, 0, 0, 0.06),
  0px 2px 4px 0px rgba(0, 0, 0, 0.04);
/* Dark mode: 0 0 0 1px rgba(255, 255, 255, 0.08) */
```
Do NOT apply to dividers/separators.

### 4. Interruptible Animations
- CSS transitions for interactive elements (hover, toggle) — they retarget mid-animation
- Keyframes only for one-shot sequences (enter animations, loading)
- Never use keyframes for drawers, dropdowns, toggles

### 5. Enter Animations: Split and Stagger
Break content into semantic chunks, stagger ~100ms:
```tsx
// opacity: 0→1, y: 12→0, filter: blur(4px)→blur(0)
// staggerChildren: 0.1
```

### 6. Exit Animations: Subtle
```tsx
exit={{ opacity: 0, y: -12, filter: "blur(4px)", transition: { duration: 0.15 } }}
```
Exit should be shorter than enter (150ms vs 300ms).

### 7. Contextual Icon Animations
EXACT values — do not deviate:
- scale: 0.25 → 1
- opacity: 0 → 1
- filter: blur(4px) → blur(0px)
- transition: { type: "spring", duration: 0.3, bounce: 0 }

### 8. Font Smoothing
```css
html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```
Apply at root level. Safe on all platforms.

### 9. Tabular Numbers
```css
font-variant-numeric: tabular-nums;
```
Use on: counters, prices, timers, table columns, any dynamic number.
Skip for: static display numbers, phone numbers, decorative numerals.

### 10. Text Wrapping
```css
h1, h2, h3 { text-wrap: balance; }     /* ≤6 lines, Tailwind: text-balance */
p, li, .card-text { text-wrap: pretty; } /* any length, Tailwind: text-pretty */
/* Long text (10+ lines): skip both */
```

### 11. Image Outlines
```css
img {
  outline: 1px solid rgba(0, 0, 0, 0.1);  /* light */
  outline-offset: -1px;
}
/* Dark: rgba(255, 255, 255, 0.1) */
/* NEVER use tinted palette colors — reads as dirt */
```
Tailwind: `outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`

### 12. Scale on Press
```tsx
<button className="active:scale-[0.96] transition-transform duration-150 ease-out">
```
Always 0.96. Never below 0.95. Use CSS transitions (interruptible). Add `static` prop to disable when distracting.

### 13. Skip Animation on Page Load
```tsx
<AnimatePresence initial={false}>  {/* prevents enter on mount */}
```
Use for toggles, tabs, icon swaps. Do NOT use for intentional entrance sequences.

### 14. Never Use `transition: all`
```css
/* Bad */  transition: all 200ms;
/* Good */ transition: transform 200ms, opacity 200ms;
```
Tailwind: `transition-[transform,opacity]` not `transition`

### 15. will-change: Use Sparingly
Only for GPU-compositable properties: transform, opacity, filter, clip-path.
Never for: background-color, padding, width, height.
Only add when you observe actual stuttering (especially Safari).

### 16. Minimum Hit Area
Interactive elements: 40×40px minimum.
```css
.small-button::after {
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 40px; height: 40px;
}
```
Tailwind: `after:absolute after:inset-0 after:size-10 after:-translate-1/2`

## Review Checklist

Before shipping any UI component:
- [ ] Nested elements use concentric border radius
- [ ] Headings use `text-balance`, paragraphs use `text-pretty`
- [ ] Dynamic numbers use `tabular-nums`
- [ ] Images have `outline-black/10 dark:outline-white/10`
- [ ] Buttons have `active:scale-[0.96]` (unless static)
- [ ] No `transition: all` anywhere
- [ ] Interactive animations use CSS transitions, not keyframes
- [ ] Hit areas ≥ 40×40px

## Reference Files

- [animations.md](./animations.md) — transitions, stagger, icon animations, scale on press
- [surfaces.md](./surfaces.md) — border radius, optical alignment, shadows, image outlines
- [typography.md](./typography.md) — text-wrap, font smoothing, tabular numbers
- [performance.md](./performance.md) — transition specificity, will-change
