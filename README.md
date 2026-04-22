# Ley Abierta

**Legislación abierta para todos.** Cada ley es un archivo Markdown. Cada reforma es un commit de Git.

Ley Abierta descarga legislación oficial, la convierte en datos versionados y legibles por máquina, y los pone a disposición de cualquier ciudadano a través de una web y una API abierta.

## Por qué

Las leyes cambian constantemente, pero seguir esos cambios es casi imposible. Las fuentes oficiales publican textos consolidados sin forma de comparar versiones. Los servicios comerciales cobran cientos de euros al mes por historial de versiones.

Las leyes son de todos. Su evolución debería ser visible, accesible y gratuita.

Lee nuestro [manifiesto](VISION.md) para entender la visión completa del proyecto.

## Capturas

| Inicio | Detalle de ley |
|--------|---------------|
| ![Inicio](branding/screenshots/homepage.png) | ![Detalle de ley](branding/screenshots/law-detail.png) |

**[Pruébalo en leyabierta.es](https://leyabierta.es)**

## Cómo funciona

1. **Descarga** legislación desde fuentes oficiales (BOE para España)
2. **Transforma** el XML oficial en Markdown estructurado con metadatos YAML
3. **Versiona** cada reforma como un commit de Git con la fecha oficial de publicación
4. **Expone** los datos a través de una API REST y una web pública

## Repos

| Repo | Contenido |
|------|-----------|
| **leyabierta** (este) | Código fuente: pipeline, API, web |
| **[leyes](https://github.com/leyabierta/leyes)** | Legislación española en Markdown + Git history |

El repo de leyes es generado automáticamente por el pipeline. Cada archivo es una norma, cada commit es una reforma:

```bash
# Clonar la legislación española
git clone https://github.com/leyabierta/leyes.git

# Ver la Constitución
cat es/BOE-A-1978-31229.md

# Ver la Ley de Cooperativas de Euskadi
cat es-pv/BOE-A-2020-615.md

# ¿Cuándo cambió una ley?
git log --oneline -- es/BOE-A-1978-31229.md

# Ver el diff exacto de una reforma
git show <commit-sha> -- es/BOE-A-1978-31229.md
```

### Estructura ELI

Las carpetas siguen el estándar [ELI](https://eur-lex.europa.eu/eli-register/about.html) (European Legislation Identifier):

```
leyes/
├── es/                    ← Legislación estatal (8,636 normas)
│   ├── BOE-A-1978-31229.md   # Constitución Española
│   ├── BOE-A-1995-25444.md   # Código Penal
│   └── ...
├── es-pv/                 ← País Vasco (209 normas)
│   ├── BOE-A-2020-615.md     # Ley de Cooperativas de Euskadi
│   └── ...
├── es-ct/                 ← Cataluña (356 normas)
├── es-an/                 ← Andalucía (181 normas)
└── ...                    ← 17 comunidades autónomas
```

Una carpeta = una jurisdicción. Un archivo = una norma. El rango y los metadatos van en el frontmatter YAML:

```yaml
---
titulo: "Ley 11/2019, de 20 de diciembre, de Cooperativas de Euskadi"
identificador: "BOE-A-2020-615"
pais: "es"
jurisdiccion: "es-pv"
rango: "ley"
fecha_publicacion: "2020-01-16"
ultima_actualizacion: "2025-01-14"
estado: "vigente"
departamento: "Comunidad Autonoma del Pais Vasco"
fuente: "https://www.boe.es/eli/es-pv/l/2019/12/20/11"
articulos: 164
reformas:
  - fecha: "2020-01-16"
    fuente: "BOE-A-2020-615"
  - fecha: "2025-01-14"
    fuente: "BOE-A-2024-26853"
materias:
  - "Cooperativas"
  - "Comunidad Autonoma del Pais Vasco"
---
```

Cada archivo es autocontenido: el frontmatter incluye metadatos, historial de reformas, categorías temáticas y referencias cruzadas. El cuerpo es el texto legal completo en Markdown.

### Fechas anteriores a 1970

Git no soporta fechas anteriores al 1 de enero de 1970 (Unix epoch). Esto afecta a unas 334 leyes publicadas entre 1835 y 1969, incluyendo el Código Civil (1889), la Ley Hipotecaria (1946) y otras normas históricas que siguen vigentes.

Para estas normas:
- La **fecha del commit** en git aparece como `1970-01-02` (el mínimo permitido)
- La **fecha real de publicación** está en el frontmatter YAML (`fecha_publicacion`) y en el trailer `Source-Date` de cada commit
- La web y la API usan la fecha real, no la del commit

## España en números

| Dato | Valor |
|------|-------|
| Normas consolidadas | 12,231 |
| Estatales | 8,646 |
| Autonómicas | 3,589 |
| Jurisdicciones | 18 (estatal + 17 CCAA) |
| Norma más antigua | 1835 |
| Norma más reformada | Ley General Seguridad Social (107 reformas) |
| Vigentes | 9,876 |
| Derogadas | 2,355 |

## Actualizaciones automáticas

Un pipeline diario (GitHub Actions) mantiene las leyes actualizadas:

- **Lunes a sábado (06:00 UTC):** Busca normas nuevas en el BOE y las añade al repo
- **Domingos (04:00 UTC):** Re-sincroniza todas las normas para detectar reformas a leyes existentes

El pipeline es idempotente: re-procesar una norma no duplica commits.

## Países

| País | Fuente | Normas | Estado |
|------|--------|--------|--------|
| España | [BOE](https://www.boe.es/) | 12,231 | Desplegado |
| Francia | [Legifrance](https://www.legifrance.gouv.fr/) | — | Planeado |
| Alemania | [BGBL](https://www.bgbl.de/) | — | Planeado |
| Portugal | [DRE](https://dre.pt/) | — | Planeado |

## Stack

TypeScript + Bun. Monorepo con tres paquetes:

- **pipeline** — descarga, parsea, transforma y genera commits
- **api** — API REST (Elysia) con SQLite + FTS5 para búsqueda full-text
- **web** — interfaz pública (Astro, 100% estática) con dark mode, SEO, diff viewer, changelog personal (/mis-cambios) y notificaciones por email de cambios legislativos

## Desarrollo

```bash
bun install
bun test
bun run check    # Biome (no ESLint)
bun run format

# Pipeline
bun run pipeline bootstrap --country es
bun run ingest
bun run ingest-analisis

# Servidores
bun run api   # http://localhost:3000
bun run web   # http://localhost:4321
```

## Contribuir

Ley Abierta es un proyecto abierto. No hace falta ser desarrollador para contribuir:

- **Reporta errores** en el texto de una ley (incluye la ley, artículo y fuente oficial)
- **Sugiere mejoras** en cómo se presenta la información
- **Añade soporte** para un nuevo país
- **Mejora el código**, la web o la API
- **Reporta bugs** o sugiere funcionalidades

Lee [CONTRIBUTING.md](CONTRIBUTING.md) para más detalles.

## Agradecimientos

Inspirado por:
- [ALEF](https://www.lavozdegalicia.es/noticia/reto-digital/ocio/2024/01/30/leyexe/00031706632270589450575.htm) — Agile Law Execution Factory, lenguaje formal de la Autoridad Fiscal holandesa para ley ejecutable
- [Legalize](https://github.com/legalize-dev) — proyecto pionero de legislación como código

## Licencia

Contenido legislativo: dominio público (procedente de publicaciones oficiales).
Código y herramientas: [AGPL-3.0](LICENSE).
