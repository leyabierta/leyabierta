# Ley Libre

**Legislacion abierta para todos.** Cada ley es un archivo Markdown. Cada reforma es un commit de Git.

Ley Libre descarga legislacion oficial, la convierte en datos versionados y legibles por maquina, y los pone a disposicion de cualquier ciudadano a traves de una web y una API abierta.

## Por que

Las leyes cambian constantemente, pero seguir esos cambios es casi imposible. Las fuentes oficiales publican textos consolidados sin forma de comparar versiones. Los servicios comerciales cobran cientos de euros al mes por historial de versiones.

Las leyes son de todos. Su evolucion deberia ser visible, accesible y gratuita.

## Como funciona

1. **Descarga** legislacion desde fuentes oficiales (BOE para Espana)
2. **Transforma** el XML oficial en Markdown estructurado con metadatos YAML
3. **Versiona** cada reforma como un commit de Git con la fecha oficial de publicacion
4. **Expone** los datos a traves de una API REST y una web publica

## Repos

El proyecto se divide en multiples repositorios:

| Repo | Contenido |
|------|-----------|
| **leylibre** (este) | Codigo fuente: pipeline, API, web |
| **[leyes-es](https://github.com/leylibre/leyes-es)** | Legislacion espanola en Markdown + Git history |

El repo de leyes es generado automaticamente por el pipeline. Cada archivo es una norma, cada commit es una reforma:

```bash
# Clonar la legislacion espanola
git clone https://github.com/leylibre/leyes-es.git

# Ver la Constitucion
cat es/BOE-A-1978-31229.md

# Ver la Ley de Cooperativas de Euskadi
cat es-pv/BOE-A-2020-615.md

# Cuando cambio una ley?
git log --oneline -- es/BOE-A-1978-31229.md

# Ver el diff exacto de una reforma
git show <commit-sha> -- es/BOE-A-1978-31229.md
```

### Estructura ELI

Las carpetas siguen el estandar [ELI](https://eur-lex.europa.eu/eli-register/about.html) (European Legislation Identifier):

```
leyes-es/
├── es/                    ← Legislacion estatal (8,636 normas)
│   ├── BOE-A-1978-31229.md   # Constitucion Espanola
│   ├── BOE-A-1995-25444.md   # Codigo Penal
│   └── ...
├── es-pv/                 ← Pais Vasco (209 normas)
│   ├── BOE-A-2020-615.md     # Ley de Cooperativas de Euskadi
│   └── ...
├── es-ct/                 ← Cataluna (356 normas)
├── es-an/                 ← Andalucia (181 normas)
└── ...                    ← 17 comunidades autonomas
```

Una carpeta = una jurisdiccion. Un archivo = una norma. El rango y los metadatos van en el frontmatter YAML:

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
---
```

## Espana en numeros

| Dato | Valor |
|------|-------|
| Normas consolidadas | 12,231 |
| Estatales | 8,636 |
| Autonomicas | 3,595 |
| Jurisdicciones | 18 (estatal + 17 CCAA) |
| Norma mas antigua | 1835 |
| Norma mas reformada | Ley General Seguridad Social (107 reformas) |
| Vigentes | 9,876 |
| Derogadas | 2,355 |

## Paises

| Pais | Fuente | Normas | Estado |
|------|--------|--------|--------|
| Espana | [BOE](https://www.boe.es/) | 12,231 | En desarrollo |
| Francia | [Legifrance](https://www.legifrance.gouv.fr/) | — | Planeado |
| Alemania | [BGBL](https://www.bgbl.de/) | — | Planeado |
| Portugal | [DRE](https://dre.pt/) | — | Planeado |

## Stack

TypeScript + Bun. Monorepo con tres paquetes:

- **pipeline** — descarga, parsea, transforma y genera commits
- **api** — API REST (Elysia) con SQLite + FTS5 para busqueda full-text
- **web** — interfaz publica (Astro) con dark mode, SEO, diff viewer

## Desarrollo

```bash
bun install
bun test
bun run check

# Pipeline
bun run pipeline bootstrap --country es
bun run ingest
bun run ingest-analisis

# Servidores
bun run api   # http://localhost:3000
bun run web   # http://localhost:4321
```

## Contribuir

Ley Libre es un proyecto abierto. Si quieres ayudar:

- Reporta errores en el texto de una ley (incluye la ley, articulo y fuente oficial)
- Anade soporte para un nuevo pais
- Mejora la web o la API
- Sugiere funcionalidades

## Agradecimientos

Inspirado por:
- [ALEF](https://www.lavozdegalicia.es/noticia/reto-digital/ocio/2024/01/30/leyexe/00031706632270589450575.htm) — Agile Law Execution Factory, lenguaje formal de la Autoridad Fiscal holandesa para ley ejecutable
- [Legalize](https://github.com/legalize-dev) — proyecto pionero de legislacion como codigo

## Licencia

Contenido legislativo: dominio publico (procedente de publicaciones oficiales).
Codigo y herramientas: [MIT](LICENSE).
