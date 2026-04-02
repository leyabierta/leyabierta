# Ley Abierta — Reporte de Robustez y Calidad de Datos

Investigación basada en el feedback público del hilo de HN sobre Legalize (807 puntos, 231 comentarios) y análisis del pipeline actual.

---

## 1. Tablas e Imágenes

**Estado actual:** El pipeline convierte tablas e imágenes a Markdown.

- **Tablas:** XML `<table>` → Markdown table syntax (pipes `|` se escapan correctamente)
- **Imágenes:** XML `<img>` → `![alt](src)` con alt por defecto "imagen"
- **Tablas vacías se descartan silenciosamente** — si `<table>` no tiene filas con celdas, se omite sin aviso

**Archivos relevantes:**
- `packages/pipeline/src/transform/xml-parser.ts` líneas 134-141 (detección), 263-300 (conversión)
- `packages/pipeline/src/transform/markdown.ts` líneas 42, 65-70 (renderizado)

**Problemas:**
- No hay tests para tablas ni imágenes (el fixture de test es la Constitución, que no tiene)
- No hay soporte para tablas complejas (colspan, rowspan) — Markdown estándar no las representa
- Tablas vacías se descartan silenciosamente

**Imágenes:** Se mantienen como links al BOE (`/datos/imagenes/disp/...`). El BOE es el source of truth para las imágenes — no las descargamos ni almacenamos. Si el BOE cambia URLs, se refleja fielmente.

**Fixtures de test disponibles** (en `data/boe-analysis/`):
- `fishing_law.xml` — tablas simples, colspan, tfoot, imágenes standalone
- `international_agreement.xml` — tablas complejas con rowspan, imágenes en celdas
- `corporate_tax.xml` — celdas con párrafos anidados (`<p>` dentro de `<td>`)
- `tax_law.xml` — 84 tablas de complejidad variada

**Acciones propuestas:**
- [ ] Añadir tests con XML real usando los fixtures anteriores
- [ ] Mejorar `tableToMarkdown()` para manejar colspan/rowspan (considerar librería o HTML fallback)
- [ ] Warning en el log cuando se descarta una tabla vacía

---

## 2. Orden de Commits

**Estado actual: CORRECTO.** El pipeline garantiza el orden cronológico.

- `extractReforms()` ordena reformas por fecha antes de commitear (`xml-parser.ts` línea 368)
- `commitNorm()` itera en orden, creando commits secuenciales
- Ambos `GIT_AUTHOR_DATE` y `GIT_COMMITTER_DATE` se establecen correctamente (`repo.ts` líneas 94-95)
- Tests verifican el orden explícitamente (`pipeline.test.ts` líneas 55-79)

**Fechas del BOE:**
- Actualmente el pipeline clampea fechas a rango 1970-2099 (`repo.ts` líneas 80-86). **Esto debe eliminarse.**
- Si el BOE dice 2929, nosotros ponemos 2929. El BOE es el source of truth.
- Las fechas anómalas (futuras, imposibles) deben detectarse y mostrarse en la página de anomalías, no "arreglarse" silenciosamente.
- Ejemplo real: BOE-A-1985-26400 tiene fecha 2929 — es una anomalía del BOE, no un bug nuestro.

**Diferencia con Legalize:** El hilo de HN señaló que Legalize tenía commits desordenados y una fecha de 2099. Nosotros tenemos el orden correcto. Para las fechas anómalas, las preservamos fielmente y las mostramos como anomalías.

---

## 3. Cobertura de la Legislación Consolidada del BOE

### Lo que SI cubre (12,231 leyes):
- 20 tipos de documento (Constitución, Leyes Orgánicas, Reales Decretos, Órdenes, etc.)
- 18 jurisdicciones (1 estatal + 17 CCAA)
- Historial completo de versiones consolidadas
- Estado vigente/derogada/parcialmente derogada
- 3,000+ materias (clasificación temática ELI)

### Lo que NO cubre:
| Gap | Descripción | Impacto |
|-----|-------------|---------|
| **Legislación no consolidada** | Publicaciones individuales del BOE diario | No vemos actos administrativos menores |
| **Sumario diario** | Endpoint `/boe/sumario/{YYYYMMDD}` no implementado | No detectamos reformas en tiempo real (solo batch) |
| **Jurisprudencia** | Sentencias del Tribunal Supremo, TC, etc. | Sin contexto de cómo se interpretan las leyes |
| **Debates parlamentarios** | Discusiones en Congreso/Senado | Sin contexto del "por qué" de cada reforma |
| **Legislación EU** | Directivas y Reglamentos europeos | Solo transposiciones españolas, no fuente EU |
| **Leyes autonómicas no registradas** | Normativa regional no publicada en BOE | Gap mínimo — la mayoría ya está vía API consolidada |
| **Reglamentos subordinados** | Instrucciones, circulares de rango inferior | Gap parcial |

### Fuentes alternativas de datos:
| Fuente | Qué ofrece | API | Prioridad |
|--------|-----------|-----|-----------|
| **CENDOJ** (poderjudicial.es) | Jurisprudencia: sentencias de TS, TC, AP | Búsqueda web (sin API REST) | Media — valor alto pero scraping difícil |
| **Congreso.es** | Debates, enmiendas, votaciones | Sin API pública | Baja — requeriría scraping |
| **EUR-Lex** | Legislación EU, estado de transposición | REST API + SPARQL | Media — complementaria |
| **BOE Sumario** | Publicaciones diarias, reformas en tiempo real | REST API (ya disponible) | **Alta** — ya tenemos acceso, falta implementar |
| **Boletines autonómicos** | Legislación regional no registrada en BOE | Varía por CCAA | Baja — la mayoría ya cubierta vía BOE consolidado (3,595 normas CCAA) |

**Acción prioritaria:** Implementar `discoverDaily()` usando el endpoint de sumario BOE. Ya tenemos el código base pero lanza error TODO.

---

## 4. Validación y Prevención de Datos Incorrectos

### Lo que funciona bien:
- Schema SQLite con foreign keys activas (`PRAGMA foreign_keys = ON`)
- `INSERT OR REPLACE` previene duplicados en tablas principales
- `parseBoeDate()` valida formato básico (YYYYMMDD, year >= 1800, month 1-12, day 1-31)
- Try-catch en ingest: archivos JSON inválidos no crashean el pipeline
- Retry con backoff exponencial para errores HTTP
- Deduplicación de reformas por `${publishedAt}|${normId}`
- Markdown linter con detección de HTML residual, entidades, frontmatter

### Gaps críticos:

#### A. Fechas anómalas del BOE
- Fechas como 2929, 99999999, o "2024-02-31" son datos del BOE, no bugs nuestros
- **No debemos clampear ni rechazar** — preservar fielmente y detectar como anomalía
- Actualmente `repo.ts` clampea (líneas 80-86) — **hay que eliminarlo**
- Acción: quitar clamping, añadir detección de anomalías para fechas fuera de rango razonable (ej. futuro, pre-1800)

#### B. Sin validación de schema en runtime
```typescript
// ingest.ts línea 109 — cast sin validacion
const data = (await Bun.file(file).json()) as CachedNorm;
```
- Si el JSON tiene estructura incorrecta, se insertará parcialmente
- No usamos Zod ni ninguna librería de validación (aunque está en node_modules)
- Campos requeridos no se verifican antes de INSERT

#### C. FTS5 acumula duplicados
- Confirmado en tests: "FTS5 INSERT OR REPLACE does not deduplicate"
- Con cada re-ingest, la búsqueda full-text devuelve resultados duplicados
- La solución es `DELETE FROM norms_fts WHERE norm_id = ?` antes de re-insertar

#### D. Linter no se ejecuta automáticamente
- `markdown-linter.ts` existe pero es una herramienta CLI manual
- El pipeline nunca valida el Markdown generado antes de commitearlo
- Markdown con HTML residual o entidades rotas puede llegar a producción

#### E. Sin transacciones atómicas
- Si el pipeline crashea a mitad de ingest, quedan datos parciales en la DB
- No hay rollback automático

#### F. Respuestas HTTP no validadas
```typescript
// boe-client.ts línea 32 — asume JSON
const json = JSON.parse(new TextDecoder().decode(bytes));
```
- Si el BOE devuelve una página HTML de error, `JSON.parse()` lanza excepción no controlada

### Lo que NO está testeado:
- XML malformado o truncado
- Respuestas HTTP que no son JSON
- Fechas fuera de rango (2099, negativos)
- Campos requeridos ausentes en metadata
- Violaciones de integridad referencial
- Problemas de encoding UTF-8
- Documentos muy grandes (memory exhaustion)

---

## 5. Plan de Mejoras por Prioridad

### P0 — Crítico (datos incorrectos en producción)

1. **Validación Zod en ingest** — Validar JSON antes de insertar en DB
2. **Fix FTS5 duplicados** — DELETE antes de INSERT en norms_fts
3. **Transacciones atómicas** — Envolver cada norm en una transacción SQLite
4. **Validar respuestas HTTP** — Comprobar Content-Type antes de JSON.parse

### P1 — Alto (calidad de datos)

5. **Quitar date clamping** — Eliminar clamping en `repo.ts`, preservar fechas del BOE fielmente
6. **Detección de anomalías en fechas** — Detectar fechas fuera de rango (futuro, pre-1800) y mostrar en página de anomalías
7. **Linter automático** — Ejecutar markdown-linter antes de git commit
8. **Tests para tablas/imágenes** — Fixtures con XML real (fishing_law, international_agreement, corporate_tax)
9. **Mejorar parser de tablas** — Soporte para colspan/rowspan
10. **Logging de warnings** — Tablas vacías, ranks desconocidos, títulos truncados

### P2 — Medio (completitud)

9. **Implementar discoverDaily()** — Endpoint sumario BOE para detección de reformas
10. **Tests para edge cases** — XML malformado, encoding, documentos grandes
11. **Checksums de contenido** — Detectar cambios inesperados entre ingestas

### P3 — Bajo (enriquecimiento futuro)

12. **CENDOJ** — Jurisprudencia superpuesta a leyes
13. **EUR-Lex** — Legislación EU y estado de transposición
14. **Blame político** — Departamento/legislatura como autor de reforma
15. **Alertas por tema** — Notificar cambios en leyes de un área

---

## 6. Resumen HN: Lo que la Gente Pide

Del hilo de Legalize (807 puntos), features más demandados:

1. **Jurisprudencia** — Sentencias superpuestas a las leyes (CENDOJ)
2. **Blame político** — Quién aprobó cada reforma (Congreso, legislatura, partido)
3. **Grafo de relaciones** — Qué leyes referencian a cuáles (ya tenemos parcialmente)
4. **Búsqueda semántica** — Taxonomía, categorías jerárquicas (tenemos materias)
5. **Tests de contradicciones** — CI para detectar leyes que se contradicen (ingenuo pero interesante con LLM)
6. **Debates parlamentarios** — Enlazar al "por qué" de cada reforma
7. **Multi-país** — Demanda de Alemania, Portugal, Suecia, Finlandia, Holanda, Brasil, Argentina, EEUU

**Nuestras ventajas sobre Legalize:**
- Calidad: página de anomalías, detección de datos incorrectos del BOE
- Cobertura: 17 CCAA incluidas (Legalize solo estatal)
- Web: búsqueda FTS, diffs, timeline (Legalize solo el repo)
- API: REST completa con 15+ endpoints
- Enfoque: citizen-first vs "exploring business"
