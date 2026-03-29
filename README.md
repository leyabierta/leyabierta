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

```bash
# Clonar la legislacion espanola
git clone https://github.com/leylibre/leylibre-es.git

# Ver el Articulo 1 de la Constitucion
cat es/constituciones/BOE-A-1978-31229.md

# Cuando cambio?
git log --oneline -- es/constituciones/BOE-A-1978-31229.md

# Ver el diff exacto de una reforma
git show <commit-sha> -- es/constituciones/BOE-A-1978-31229.md
```

## Paises

| Pais | Fuente | Estado |
|------|--------|--------|
| Espana | [BOE](https://www.boe.es/) | En desarrollo |

## Stack

TypeScript + Bun. Monorepo con tres paquetes:

- **pipeline** — descarga, parsea, transforma y genera commits
- **api** — API REST para consultar legislacion
- **web** — interfaz publica para ciudadanos

## Desarrollo

```bash
bun install
bun test
bun run check
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
