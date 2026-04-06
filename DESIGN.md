# Design System — Ley Abierta

## Product Context
- **What this is:** Open source engine that makes Spanish legislation searchable, comparable, and understandable for every citizen
- **Who it's for:** Citizens first, journalists, researchers, lawyers second. Non-technical users are the primary audience.
- **Space/industry:** Civic tech, legislative transparency, open government data
- **Project type:** Web app (static Astro site + REST API). Public service, not SaaS.
- **Reference sites:** GOV.UK (clarity), BOE (institutional trust), La Moncloa (Spanish gov aesthetics)

## Aesthetic Direction
- **Direction:** Editorial / Institutional — serif authority meets sans-serif clarity
- **Decoration level:** Intentional — subtle surface treatments (#fafaf8 warm background, soft borders), no gradients, no decorative elements
- **Mood:** Trustworthy, serious, accessible. Like a well-designed government report that anyone can read. Not a startup, not a dashboard, not a toy.
- **Logo concept:** The A in "Ley Abierta" is a half-open door, symbolizing open access to legislation. Serif letterforms evoke institutional authority.

## Typography
- **Display/Hero:** Source Serif 4 (700) — serif authority, evokes official gazette tradition. Optical sizing 8-60.
- **Body/UI:** Inter (400, 500, 600) — high legibility at small sizes, clean UI text. Tabular-nums for stats.
- **Data/Code:** JetBrains Mono (400, 500) — norm IDs (BOE-A-1978-31229), API references, technical data.
- **Loading:** Google Fonts CDN: `Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400` + `Inter:wght@400;500;600;700` + `JetBrains+Mono:wght@400;500`
- **Scale:**
  - `xs`: 12px / 0.75rem — metadata labels, timestamps
  - `sm`: 13px / 0.8125rem — navigation links, secondary text
  - `base`: 14px / 0.875rem — body text, descriptions
  - `md`: 15px / 0.9375rem — section descriptions
  - `lg`: 16px / 1rem — stat pills, emphasis
  - `xl`: 18px / 1.125rem — navbar logo text, legal body text
  - `2xl`: 24px / 1.5rem — h2 subsections (Source Serif 4, 600)
  - `3xl`: 28px / 1.75rem — section headings (Source Serif 4, 700)
  - `4xl`: 36px / 2.25rem — law titles (Source Serif 4, 700)
  - `5xl`: 48px / 3rem — hero heading (Source Serif 4, 700)

## Color

- **Approach:** Restrained — one accent (institutional blue) + warm neutrals. Color is rare and meaningful.

### Core palette
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-primary` | `#1a365d` | Accent, links, nav bar, institutional blue |
| `--color-text` | `#0b1120` | Headings, body text |
| `--color-bg` | `#fafaf8` | Page background (warm off-white) |
| `--color-surface` | `#ffffff` | Cards, inputs, elevated surfaces |
| `--color-text-secondary` | `#4a6078` | Descriptions, metadata |
| `--color-text-muted` | `#6b8299` | Labels, dates, subtle text |
| `--color-accent-bg` | `#e6eef8` | Accent background (pills, tags, highlights) |
| `--color-border` | `#e8ecf0` | Borders, dividers, card outlines |

### Semantic colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-success` | `#1a7a4e` | Added text, vigente status, positive |
| `--color-success-bg` | `#e3f4ec` | Success background |
| `--color-error` | `#b91c1c` | Deleted text, derogado status, negative |
| `--color-error-bg` | `#fde8e8` | Error background |
| `--color-warning` | `#b8860b` | Warnings, caution states |

### Dark mode strategy
- Invert surfaces: `--color-bg` becomes `#0f172a`, `--color-surface` becomes `#1e293b`
- Reduce primary saturation 10-20%: `#1a365d` → `#2d5a8e` (lighter for contrast on dark)
- Text becomes `#e2e8f0` (light gray), muted becomes `#94a3b8`
- Semantic colors stay recognizable but lighten slightly for contrast
- Border becomes `#334155`

## Spacing
- **Base unit:** 8px
- **Density:** Comfortable — generous whitespace for reading legal text
- **Scale:**
  - `2xs`: 2px
  - `xs`: 4px
  - `sm`: 8px
  - `md`: 16px
  - `lg`: 24px
  - `xl`: 32px
  - `2xl`: 40px
  - `3xl`: 48px
  - `4xl`: 60px
  - `5xl`: 80px
- **Section spacing:** 80px between major sections, 32px between subsections
- **Component internal padding:** 20-32px for cards, 14-16px for info blocks

## Layout
- **Approach:** Grid-disciplined — clean columns, predictable alignment. Single-column for legal text reading.
- **Max content width:** 1200px (page container)
- **Legal text max width:** 640-720px (optimal reading measure for long-form legal text)
- **Grid:** Responsive: 1 col mobile, 2 col tablet, up to 5 col desktop (color swatches, logo variants)
- **Border radius:**
  - `sm`: 4px — tags, inline badges
  - `md`: 8px — stat pills, small cards
  - `lg`: 10-12px — cards, inputs, component containers
  - `xl`: 16px — large cards, logo display areas
  - `full`: 9999px — circular elements
- **Navbar height:** 56px
- **Elevation:** No shadows. Depth via borders (`1px solid #e8ecf0`) and background color differences.

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** `ease-out` for entrances, `ease-in` for exits, `ease-in-out` for state changes
- **Duration:**
  - `micro`: 50-100ms — hover states, toggles
  - `short`: 150-250ms — tab switches, small reveals
  - `medium`: 250-400ms — page transitions, panels
- **No decorative animations.** No bouncing, no parallax, no scroll-driven effects. This is a government-style resource, not a marketing site.

## Voice & Tone
- **For citizens, not lawyers.** Plain Spanish, no jargon.
- **Correct orthography always:** accents (á, é, í, ó, ú), ñ, ü, ¿, ¡
- **Term mapping:**
  - "leyes" not "normas" (citizen-facing)
  - "artículos" not "bloques" or "preceptos"
  - "cambios" or "modificaciones" not "diffs" or "reformas" (in headings)
  - "temas" or "categorías" not "materias"
  - "buscar leyes" not "buscar normas consolidadas"
- **Stats as natural language:** "Más de 12.000 leyes" not "12,231 norms"
- **Do:** "Las leyes de España, accesibles para todos", "Cada cambio, documentado", "Antes decía X, ahora dice Y"
- **Don't:** "Legislación versionada con Git", "+42.000 commits", "Diff unificado entre versiones", "Pipeline incremental diario"

## Anti-patterns (never use)
- Purple/violet gradients
- 3-column feature grids with icons in colored circles
- Centered-everything layouts
- Gradient buttons
- Generic stock-photo hero sections
- Drop shadows for depth (use borders instead)
- Decorative blobs, waves, or abstract shapes
- Dashboard-style number counters with decimals

## Component Patterns
- **Navbar:** White background, logo (favicon + "Ley Abierta" in Source Serif 4), right-aligned navigation links in Inter 500 13px
- **Stat pills:** `#e6eef8` background, `#1a365d` text, 8px border-radius, natural language content
- **Change cards:** White surface, border, title in 600 weight, date in muted, old text in red strikethrough, new text in green 500 weight
- **Footer:** `#1a365d` background, white text, simple two-column flex layout

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04 | Initial design system formalized | Extracted from branding.html brand guidelines. Institutional aesthetic chosen for citizen trust. Source Serif 4 for authority, Inter for UI readability, JetBrains Mono for technical data. |
| 2026-04 | No shadows, borders only | Flat, institutional feel. Shadows feel too "app-like" for a public service. |
| 2026-04 | Warm off-white (#fafaf8) not pure white | Easier on the eyes for reading legal text. Subtle warmth adds friendliness without losing authority. |
| 2026-04 | Inter kept as body font | Despite being overused, Inter's tabular-nums, optical sizing, and legibility at 13-14px make it the right tool for a data-heavy civic site. The serif display font carries the visual identity. |
