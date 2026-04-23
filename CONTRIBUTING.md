# Contribuir a Ley Abierta

Ley Abierta es un proyecto cívico de código abierto que convierte la legislación oficial en archivos Markdown con control de versiones, para que cualquier persona pueda buscar, comparar y entender cómo cambian las leyes.

Antes de contribuir, lee la [visión del proyecto](VISION.md) para entender los principios que guían las decisiones.

## Formas de contribuir

### Para cualquier persona

- **Reportar errores en el texto de una ley**: Si encuentras texto incorrecto, [abre un issue](../../issues/new?template=data_error.md) indicando el identificador de la ley (ej. `BOE-A-1978-31229`), el artículo afectado y un enlace a la fuente oficial del BOE
- **Sugerir mejoras de accesibilidad**: ¿Algo no se entiende? ¿La información podría presentarse mejor? Cuéntanoslo en [Discussions](../../discussions)
- **Proponer funcionalidades**: Abre una discusión con tu idea. Toda propuesta es bienvenida

### Para juristas

- **Revisar resúmenes ciudadanos**: Los resúmenes se generan con IA. Si detectas imprecisiones o mejores formas de explicar un concepto legal, abre un issue
- **Validar datos legislativos**: Comprobar que los metadatos (estado, fecha, reformas) son correctos

### Para periodistas e investigadores

- **Documentar casos de uso**: ¿Cómo usarías Ley Abierta en tu trabajo? Compártelo en Discussions
- **Señalar qué información falta**: ¿Qué datos serían útiles para tu investigación?

### Para desarrolladores

- **Mejorar la web o la API**: La web usa Astro (100% estática). La API usa Elysia con SQLite + FTS5. Consulta `packages/web/` y `packages/api/`
- **Añadir soporte para un nuevo país**: La arquitectura del pipeline es independiente del país. Consulta `packages/pipeline/` para ver la implementación de España como referencia
- **Reportar bugs**: Usa [GitHub Issues](../../issues) con la plantilla adecuada

## Configuración de desarrollo

```bash
# Clonar y arrancar
git clone https://github.com/leyabierta/leyabierta.git
cd leyabierta
bun install

# Comprobar que todo funciona
bun test
bun run check    # Biome (no ESLint)
bun run format

# Arrancar servidores
bun run api      # http://localhost:3000
bun run web      # http://localhost:4321
```

## Convenciones

- **Código y comentarios** en inglés
- **Contenido para el usuario** (web, API) en castellano, con acentos y caracteres correctos (ñ, á, é, í, ó, ú, ¿, ¡)
- Usar `bun` en lugar de `npm`, `bunx` en lugar de `npx`
- Biome para linting y formateo
- Fechas en formato ISO 8601 en las interfaces

## Enviar un PR

1. Haz fork del repo y crea una rama
2. Haz tus cambios
3. Ejecuta `bun test` y `bun run check`
4. Abre un PR con una descripción clara de qué cambia y por qué

## Código de conducta

Este proyecto se adhiere al [Contributor Covenant](CODE_OF_CONDUCT.md). Al participar, te comprometes a respetar sus términos.
