# Contributing to Ley Abierta

Ley Abierta is a civic tech project that turns official legislation into version-controlled Markdown so anyone can search, compare, and understand how laws change over time. Contributions are welcome.

## Ways to contribute

### Report errors in law text

If you find incorrect text in a law, [open a data error issue](../../issues/new?template=data_error.md) with:

- The law ID (e.g. `BOE-A-1978-31229`)
- The article or section affected
- A link to the official BOE source showing the correct text

### Add support for a new country

The pipeline architecture is country-agnostic. Each country implements:

- `LegislativeClient` — fetch raw text and metadata
- `NormDiscovery` — discover norms and updates
- `TextParser` — parse source format into structured blocks
- `MetadataParser` — normalize metadata

See `packages/pipeline/` for the Spain implementation as reference.

### Improve the web or API

The web frontend uses Astro (server-rendered, no JS frameworks). The API uses Elysia with SQLite + FTS5. See `packages/web/` and `packages/api/`.

### Report bugs or suggest features

Use [GitHub Issues](../../issues). Pick the appropriate template.

## Development setup

```bash
bun install
bun test
bun run check    # Biome linter + formatter (not ESLint)
bun run format   # Auto-format with Biome
```

## Conventions

- **Code and comments** in English
- **User-facing content** (web UI, API responses) in Spanish
- Use `bun` not `npm`, `bunx` not `npx`
- Biome for linting and formatting
- Dates as ISO 8601 strings at boundaries

## Submitting a PR

1. Fork the repo and create a branch
2. Make your changes
3. Run `bun test` and `bun run check`
4. Open a PR with a clear description

---

# Contribuir a Ley Abierta

Ley Abierta es un proyecto cívico de código abierto que convierte la legislación oficial en archivos Markdown con control de versiones, para que cualquier persona pueda buscar, comparar y entender cómo cambian las leyes.

## Formas de contribuir

### Reportar errores en el texto de una ley

Si encuentras texto incorrecto en una ley, abre un issue con:

- El identificador de la ley (ej. `BOE-A-1978-31229`)
- El artículo o sección afectada
- Un enlace a la fuente oficial del BOE con el texto correcto

### Añadir soporte para un nuevo país

La arquitectura del pipeline es independiente del país. Consulta `packages/pipeline/` para ver la implementación de España como referencia.

### Mejorar la web o la API

La web usa Astro (renderizado en servidor). La API usa Elysia con SQLite + FTS5. Consulta `packages/web/` y `packages/api/`.

### Reportar bugs o sugerir funcionalidades

Usa [GitHub Issues](../../issues) con la plantilla adecuada.

## Configuración de desarrollo

```bash
bun install
bun test
bun run check    # Biome (no ESLint)
bun run format
```

## Convenciones

- **Código y comentarios** en inglés
- **Contenido para el usuario** (web, API) en castellano
- Usar `bun` en lugar de `npm`, `bunx` en lugar de `npx`
