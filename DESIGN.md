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

Three typographic registers, each with a clear role:

- **Source Serif 4** (serif): Authority and tradition. Law titles, section headings, citizen summaries, article body text, hero headings, footer tagline. Weights 400–700, optical sizing 8–60.
- **Inter** (sans-serif): Readability and interface. Body text, navigation, descriptions, labels, metadata. Weights 400–700. Tabular-nums for statistics.
- **JetBrains Mono** (monospace): Technical precision. Norm IDs (BOE-A-1978-31229), section kickers, date stamps, breadcrumbs. Always uppercase with letter-spacing 0.1–0.15em. The most distinctive typographic pattern in the system.

**Loading:** Google Fonts CDN: `Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400` + `Inter:wght@400;500;600;700` + `JetBrains+Mono:wght@400;500`

**Scale:**
| Token | Size | Usage |
|-------|------|-------|
| `xs` | 12px / 0.75rem | Metadata labels, timestamps |
| `sm` | 13px / 0.8125rem | Navigation links, secondary text, tabs |
| `base` | 14px / 0.875rem | Body text, descriptions |
| `md` | 15px / 0.9375rem | Section descriptions |
| `lg` | 16px / 1rem | Stat pills, emphasis |
| `xl` | 18px / 1.125rem | Legal body text in reader |
| `2xl` | 24px / 1.5rem | h2 subsections (Source Serif, 600) |
| `3xl` | 28px / 1.75rem | Section headings (Source Serif, 700) |
| `4xl` | 36px / 2.25rem | Law titles (Source Serif, 700) |
| `5xl` | 48px / 3rem | Hero heading (Source Serif, 700) |

## Color

**Approach:** Restrained — one accent (institutional blue) + warm neutrals. Color is rare and meaningful.

### Core palette
| Token | Hex | Usage |
|-------|-----|-------|
| `--accent` | `#1a365d` | The single accent. Links, active tabs, buttons, selected items, nav highlights |
| `--text` | `#0b1120` | Headings, body text (near-black with blue undertone) |
| `--bg` | `#fafaf8` | Page background (warm off-white) |
| `--surface` | `#ffffff` | Cards, inputs, elevated surfaces |
| `--text-secondary` | `#4a6078` | Descriptions, metadata |
| `--text-muted` | `#6b8299` | Labels, kickers, subtle text |
| `--accent-bg` | `#e6eef8` | Accent background — pills, tags, highlights, icon blocks |
| `--accent-bg-light` | `#f2f6fb` | Very light accent — CTA banners, featured items |
| `--border` | `#e8ecf0` | Light borders, card outlines, dividers |
| `--border-medium` | `#c4ced8` | Medium borders, nav bottom, separators between sections |

### Warm palette
| Token | Hex | Usage |
|-------|-----|-------|
| `--tierra` | `#efe9de` | Warm cream — footer background, marginalia panels, "human/citizen" contexts |
| `--tierra-deep` | `#d9cdb8` | Warm border — footer top border, marginalia card borders |

**Warm vs. cool distinction:** Cool white (`#ffffff`) is for institutional/legal content — the law itself. Warm cream (`#efe9de`) is reserved for citizen-facing annotations, the footer, and any context where the system speaks in a human voice rather than an official one.

### Semantic colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--success` | `#1a7a4e` | Added text, vigente status, positive |
| `--success-bg` | `#e3f4ec` | Success background |
| `--error` | `#b91c1c` | Deleted text, derogado status, negative |
| `--error-bg` | `#fde8e8` | Error background |
| `--warning` | `#b8860b` | Warnings, caution states |

### Dark mode
- Surfaces invert: `--bg` → `#0f172a`, `--surface` → `#1e293b`
- Accent lightens for contrast: `#1a365d` → `#2d5a8e`
- Text becomes `#e2e8f0`, muted becomes `#94a3b8`
- Borders become `#334155`
- Warm palette becomes dark warm: `#efe9de` → `#2a2520`
- Semantic colors stay recognizable but lighten slightly

## Spacing
- **Base unit:** 8px
- **Density:** Comfortable — generous whitespace for reading legal text
- **Scale:**

| Token | Size |
|-------|------|
| `2xs` | 2px |
| `xs` | 4px |
| `sm` | 8px |
| `md` | 16px |
| `lg` | 24px |
| `xl` | 32px |
| `2xl` | 40px |
| `3xl` | 48px |
| `4xl` | 60px |
| `5xl` | 80px |

- **Section spacing:** 80px between major page sections, 32px between subsections
- **Component internal padding:** 20–32px for cards, 14–16px for compact info blocks

## Layout
- **Approach:** Grid-disciplined — clean columns, predictable alignment. Single-column for legal text reading.
- **Max content width:** 1200px (page containers with mixed content)
- **Reading width:** 52rem / 832px (legal text, single-column content — optimal measure for long-form reading)
- **Grid:** Responsive: 1 col mobile, 2 col tablet, up to 3 col desktop for content grids
- **Border radius:**

| Token | Size | Usage |
|-------|------|-------|
| `sm` | 4px | Tags, inline badges, small pills |
| `md` | 8px | Stat pills, small cards |
| `lg` | 10–12px | Content cards, inputs, component containers |
| `xl` | 16px | Large cards, logo display areas |
| `full` | 9999px | Circular elements |

- **Navbar height:** 56px
- **Elevation:** No shadows. Depth via borders (`1px solid var(--border)`) and background color differences. This is a deliberate choice — shadows feel too "app-like" for a public service.

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** `ease-out` for entrances, `ease-in` for exits, `ease-in-out` for state changes
- **Duration:**
  - `micro`: 50–100ms — hover states, toggles
  - `short`: 150–250ms — tab switches, small reveals
  - `medium`: 250–400ms — page transitions, panels
- **Scroll animations:** Subtle `translateY(12px)` + `opacity: 0` → visible on scroll. One-shot, no repeat. `threshold: 0.15`.
- **No decorative animations.** No bouncing, no parallax, no spring physics. This is a government-style resource, not a marketing site.

## Component Patterns

### Mono Kicker
The most distinctive element in the system. Used as a category label above content throughout the site.
- JetBrains Mono, 0.6875rem, uppercase, letter-spacing 0.12em, `var(--text-muted)`
- Examples: "LEGISLACIÓN AUTONÓMICA", "RESUMEN CIUDADANO", "ART. 18", "CASO DE EJEMPLO"

### Content Card
The universal container for elevated content.
- Background: `var(--surface)` (white)
- Border: `1px solid var(--border)`
- Border-radius: 10–12px
- Padding: 1.25–1.5rem
- No shadows, ever

### Section Heading
Consistent section breaks within a page.
- Source Serif 4, 1.2rem, weight 600, `var(--text)`
- Optional: 1px bottom border with 0.5rem padding-bottom

### Tags / Chips
For categories, topics, and filter options.
- Font: 0.8125rem, weight 500
- Padding: 0.3rem 0.75rem
- Border-radius: 4px
- Default: `var(--accent-bg)` background, `var(--accent)` text
- Interactive: cursor pointer, hover darkens background

### Status Badge
Small colored pills for law status.
- Font: 0.6875rem, weight 600
- Vigente: `var(--success-bg)` bg, `var(--success)` text
- Derogada: `var(--error-bg)` bg, `var(--error)` text

### Tab Bar
Underline-style tabs for switching content views.
- Font: 0.8125rem Inter
- Active: `var(--accent)` text + 2px solid bottom border
- Inactive: `var(--text-muted)` text + transparent border
- Optional: count badge as small pill

### Timeline
For reform history and changelogs.
- Vertical line: 1px `var(--border-medium)`
- Dots: 0.75rem, `var(--surface)` fill, 2px `var(--accent)` stroke
- Dates: mono kicker style
- Titles: Source Serif

### CTA Banner
Inline call-to-action within content.
- Background: `var(--accent-bg-light)` (#f2f6fb)
- Border: 1px `#d9e3ef`
- Border-radius: 10px
- Layout: text left + button right

### FAQ Accordion
Expandable question/answer blocks.
- Border-bottom on each item
- Question in sans-serif weight 500
- +/× icon toggle on the right
- Answer text in `var(--text-secondary)`, indented

### Dark Section
Full-bleed dark backgrounds for emphasis (e.g., closing CTA).
- Background: `var(--accent)` (#1a365d)
- Text: white
- Headings: Source Serif
- Inputs/buttons invert colors

### Meta Row
Inline metadata with dot separators.
- Flex layout with `·` separators in `var(--border-medium)`
- Mixed text items and mono-styled IDs

### Primary Button
- Background: `var(--accent)`
- Color: white
- Border-radius: 6px
- Font: 0.875rem, weight 600
- Hover: lighten background slightly

### Outline Button
- Background: transparent or white
- Border: 1.5px `var(--border-medium)`
- Color: `var(--text-secondary)`
- Border-radius: 6px

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
- AI-generated stock photography or illustrations

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04 | Initial design system formalized | Extracted from branding.html brand guidelines. Institutional aesthetic chosen for citizen trust. Source Serif 4 for authority, Inter for UI readability, JetBrains Mono for technical data. |
| 2026-04 | No shadows, borders only | Flat, institutional feel. Shadows feel too "app-like" for a public service. |
| 2026-04 | Warm off-white (#fafaf8) not pure white | Easier on the eyes for reading legal text. Subtle warmth adds friendliness without losing authority. |
| 2026-04 | Inter kept as body font | Despite being overused, Inter's tabular-nums, optical sizing, and legibility at 13-14px make it the right tool for a data-heavy civic site. The serif display font carries the visual identity. |
| 2026-04 | Warm/cool distinction | `#efe9de` (cream) reserved for human/citizen contexts (footer, marginalia, annotations). Cool white for legal/institutional content. Creates a visual "bilingual" experience. |
| 2026-04 | Mono kickers as primary labeling pattern | JetBrains Mono uppercase labels are the most recognizable element in the system. Used universally above content blocks to signal category/context. |
| 2026-04 | Homepage compact (7 sections) over conservative (13) | Less is more. Hero + map + explainer + recent changes + FAQ + CTA. Every section earns its place. |
| 2026-04 | IGN geographic data for Spain map | Official Instituto Geográfico Nacional data via es-atlas (MIT). Accurate autonomous community boundaries, not approximations. |
