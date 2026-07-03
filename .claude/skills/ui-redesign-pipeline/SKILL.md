---
name: ui-redesign-pipeline
description: End-to-end workflow for redesigning user interfaces. Use when the user requests a UI/UX redesign, modernization, or mobile adaptation of an existing webpage or application. Guides through analysis, trend research, concept creation, visual mockup generation, and developer prompt writing. Specialized for TourHab / Volcano OS projects.
license: Complete terms in LICENSE.txt
---

# UI Redesign Pipeline

This skill provides a structured, 5-step workflow for redesigning user interfaces. It ensures redesigns are grounded in current trends, visually compelling, and actionable for developers while strictly adhering to project design systems.

## When to Use This Skill

Use this workflow whenever a user asks to:
- "Redesign this page"
- "Make this UI look modern"
- "Adapt this website for mobile"
- "Create a new concept for this app"

## Critical Project Constraints (Volcano OS / TourHab)
If working on the TourHab / Volcano OS project, you **MUST** adhere to these rules from `DESIGN.md`:
- **NO Glassmorphism**: `backdrop-blur` and semi-transparent cards are strictly forbidden. Do not use them in mockups or code prompts.
- **NO Nested Cards**: Do not place cards inside other cards.
- **Typography**: Playfair Display for headings (`font-playfair`), Outfit for body text. No `font-black`, max weight is `font-bold`.
- **Colors**: Use ONLY CSS variables (`var(--bg-primary)`, `var(--bg-card)`, `var(--accent)`, `var(--ocean)`, `var(--success)`, `var(--danger)`). No hardcoded hex values.
- **Corners**: `rounded-lg` everywhere. No `rounded-2xl`.
- **Icons**: Lucide React only. No emojis in UI.
- **Theme**: Warm, earthy, natural (lava, volcanoes, taiga). Not cyberpunk, not generic startup-white.

## The 5-Step Redesign Workflow

Follow these steps sequentially to deliver a complete redesign package.

### Step 1: UI/UX Audit
Analyze the current interface (using browser tools or provided screenshots/code).
1. Identify the core user goal for the screen.
2. Map the current structure (header, hero, content blocks, navigation).
3. Identify friction points (e.g., visual clutter, overwhelming choices, unclear CTAs, outdated patterns).
4. Save your findings to a markdown file (e.g., `audit_notes.md`).

### Step 2: Trend Research
Ground your redesign in current design realities.
1. Search the web for current UI/UX trends relevant to the specific domain (e.g., "mobile travel app UI trends 2026", "fintech dashboard design patterns").
2. Extract 3-4 key trends that directly solve the problems identified in Step 1 (e.g., Dynamic Minimalism, Bento UI grids, Contextual Awareness). *Note: Filter out trends that violate project constraints (e.g., Glassmorphism).*

### Step 3: Concept Strategy
Write a clear, structured concept document explaining the *why* and *what* of the redesign.
Use the template provided in `/home/ubuntu/skills/ui-redesign-pipeline/templates/concept_template.md`.
The concept must shift the paradigm (e.g., "From Marketplace to Field OS Dashboard") rather than just changing colors.

### Step 4: Visual Mockup Generation
Generate a high-quality visual mockup using the `generate_image` tool.
1. Craft a highly detailed prompt describing the exact layout, colors, and UI elements.
2. Specify the aspect ratio (`9:16` for mobile, `16:9` for desktop).
3. Example prompt structure: `[Platform] UI mockup, [Theme] mode. A [App Type] called '[Name]'. Top section: [Details]. Middle section: [Bento grid / Cards details]. Bottom: [Navigation details]. Modern, clean, professional UI design. Solid background [Color], accent [Color]. NO glassmorphism.`

### Step 5: Developer Handoff Prompt
Write an actionable prompt for a coding agent to implement the design.
1. If you have access to the codebase, map your new UI components to specific existing files.
2. Break the implementation down into specific, achievable tasks.
3. Explicitly state the CSS variables and utility classes (e.g., `ds-card`, `ds-btn`) to be used.
4. Use the template provided in `/home/ubuntu/skills/ui-redesign-pipeline/templates/handoff_prompt_template.md`.

## Delivery
Deliver the final result to the user using the `message` tool.
Include a brief summary of the core concept and attach:
1. The Concept Strategy markdown file.
2. The generated UI mockup image.
3. The Developer Handoff Prompt markdown file.
