# Ley Abierta — Reporte de Robustez y Calidad de Datos

Investigacion basada en el feedback publico del hilo de HN sobre Legalize (807 puntos, 231 comentarios) y analisis del pipeline actual.

---

## 1. Tablas e Imagenes

**Estado actual:** El pipeline convierte tablas e imagenes a Markdown.

- **Tablas:** XML `<table>` → Markdown table syntax (pipes `|` se escapan correctamente)
- **Imagenes:** XML `<img>` → `![alt](src)` con alt por defecto "imagen"
- **Tablas vacias se descartan silenciosamente** — si `<table>` no tiene filas con celdas, se omite sin aviso

**Archivos relevantes:**
- `packages/pipeline/src/transform/xml-parser.ts` lineas 134-141 (deteccion), 263-300 (conversion)
- `packages/pipeline/src/transform/markdown.ts` lineas 42, 65-70 (renderizado)

**Problemas:**
- No hay tests para tablas ni imagenes (el fixture de test es la Constitucion, que no tiene)
- No hay soporte para tablas complejas (colspan, rowspan) — Markdown estandar no las representa
- Tablas vacias se descartan silenciosamente

**Imagenes:** Se mantienen como links al BOE (`/datos/imagenes/disp/...`). El BOE es el source of truth para las imagenes — no las descargamos ni almacenamos. Si el BOE cambia URLs, se refleja fielmente.

**Fixtures de test disponibles** (en `data/boe-analysis/`):
- `fishing_law.xml` — tablas simples, colspan, tfoot, imagenes standalone
- `international_agreement.xml` — tablas complejas con rowspan, imagenes en celdas
- `corporate_tax.xml` — celdas con parrafos anidados (`<p>` dentro de `<td>`)
- `tax_law.xml` — 84 tablas de complejidad variada

**Acciones propuestas:**
- [ ] Anadir tests con XML real usando los fixtures anteriores
- [ ] Mejorar `tableToMarkdown()` para manejar colspan/rowspan (considerar libreria o HTML fallback)
- [ ] Warning en el log cuando se descarta una tabla vacia

---

## 2. Orden de Commits

**Estado actual: CORRECTO.** El pipeline garantiza el orden cronologico.

- `extractReforms()` ordena reformas por fecha antes de commitear (`xml-parser.ts` linea 368)
- `commitNorm()` itera en orden, creando commits secuenciales
- Ambos `GIT_AUTHOR_DATE` y `GIT_COMMITTER_DATE` se establecen correctamente (`repo.ts` lineas 94-95)
- Tests verifican el orden explicitamente (`pipeline.test.ts` lineas 55-79)

**Fechas del BOE:**
- Actualmente el pipeline clampea fechas a rango 1970-2099 (`repo.ts` lineas 80-86). **Esto debe eliminarse.**
- Si el BOE dice 2929, nosotros ponemos 2929. El BOE es el source of truth.
- Las fechas anomalas (futuras, imposibles) deben detectarse y mostrarse en la pagina de anomalias, no "arreglarse" silenciosamente.
- Ejemplo real: BOE-A-1985-26400 tiene fecha 2929 — es una anomalia del BOE, no un bug nuestro.

**Diferencia con Legalize:** El hilo de HN senalo que Legalize tenia commits desordenados y una fecha de 2099. Nosotros tenemos el orden correcto. Para las fechas anomalas, las preservamos fielmente y las mostramos como anomalias.

---

## 3. Cobertura de la Legislacion Consolidada del BOE

### Lo que SI cubre (12,231 leyes):
- 20 tipos de documento (Constitucion, Leyes Organicas, Reales Decretos, Ordenes, etc.)
- 18 jurisdicciones (1 estatal + 17 CCAA)
- Historial completo de versiones consolidadas
- Estado vigente/derogada/parcialmente derogada
- 3,000+ materias (clasificacion tematica ELI)

### Lo que NO cubre:
| Gap | Descripcion | Impacto |
|-----|-------------|---------|
| **Legislacion no consolidada** | Publicaciones individuales del BOE diario | No vemos actos administrativos menores |
| **Sumario diario** | Endpoint `/boe/sumario/{YYYYMMDD}` no implementado | No detectamos reformas en tiempo real (solo batch) |
| **Jurisprudencia** | Sentencias del Tribunal Supremo, TC, etc. | Sin contexto de como se interpretan las leyes |
| **Debates parlamentarios** | Discusiones en Congreso/Senado | Sin contexto del "por que" de cada reforma |
| **Legislacion EU** | Directivas y Reglamentos europeos | Solo transposiciones espanolas, no fuente EU |
| **Leyes autonomicas no registradas** | Normativa regional no publicada en BOE | Gap minimo — la mayoria ya esta via API consolidada |
| **Reglamentos subordinados** | Instrucciones, circulares de rango inferior | Gap parcial |

### Fuentes alternativas de datos:
| Fuente | Que ofrece | API | Prioridad |
|--------|-----------|-----|-----------|
| **CENDOJ** (poderjudicial.es) | Jurisprudencia: sentencias de TS, TC, AP | Busqueda web (sin API REST) | Media — valor alto pero scraping dificil |
| **Congreso.es** | Debates, enmiendas, votaciones | Sin API publica | Baja — requeriria scraping |
| **EUR-Lex** | Legislacion EU, estado de transposicion | REST API + SPARQL | Media — complementaria |
| **BOE Sumario** | Publicaciones diarias, reformas en tiempo real | REST API (ya disponible) | **Alta** — ya tenemos acceso, falta implementar |
| **Boletines autonomicos** | Legislacion regional no registrada en BOE | Varia por CCAA | Baja — la mayoria ya cubierta via BOE consolidado (3,595 normas CCAA) |

**Accion prioritaria:** Implementar `discoverDaily()` usando el endpoint de sumario BOE. Ya tenemos el codigo base pero lanza error TODO.

---

## 4. Validacion y Prevencion de Datos Incorrectos

### Lo que funciona bien:
- Schema SQLite con foreign keys activas (`PRAGMA foreign_keys = ON`)
- `INSERT OR REPLACE` previene duplicados en tablas principales
- `parseBoeDate()` valida formato basico (YYYYMMDD, year >= 1800, month 1-12, day 1-31)
- Try-catch en ingest: archivos JSON invalidos no crashean el pipeline
- Retry con backoff exponencial para errores HTTP
- Deduplicacion de reformas por `${publishedAt}|${normId}`
- Markdown linter con deteccion de HTML residual, entidades, frontmatter

### Gaps criticos:

#### A. Fechas anomalas del BOE
- Fechas como 2929, 99999999, o "2024-02-31" son datos del BOE, no bugs nuestros
- **No debemos clampear ni rechazar** — preservar fielmente y detectar como anomalia
- Actualmente `repo.ts` clampea (lineas 80-86) — **hay que eliminarlo**
- Accion: quitar clamping, anadir deteccion de anomalias para fechas fuera de rango razonable (ej. futuro, pre-1800)

#### B. Sin validacion de schema en runtime
```typescript
// ingest.ts linea 109 — cast sin validacion
const data = (await Bun.file(file).json()) as CachedNorm;
```
- Si el JSON tiene estructura incorrecta, se insertara parcialmente
- No usamos Zod ni ninguna libreria de validacion (aunque esta en node_modules)
- Campos requeridos no se verifican antes de INSERT

#### C. FTS5 acumula duplicados
- Confirmado en tests: "FTS5 INSERT OR REPLACE does not deduplicate"
- Con cada re-ingest, la busqueda full-text devuelve resultados duplicados
- La solucion es `DELETE FROM norms_fts WHERE norm_id = ?` antes de re-insertar

#### D. Linter no se ejecuta automaticamente
- `markdown-linter.ts` existe pero es una herramienta CLI manual
- El pipeline nunca valida el Markdown generado antes de commitearlo
- Markdown con HTML residual o entidades rotas puede llegar a produccion

#### E. Sin transacciones atomicas
- Si el pipeline crashea a mitad de ingest, quedan datos parciales en la DB
- No hay rollback automatico

#### F. Respuestas HTTP no validadas
```typescript
// boe-client.ts linea 32 — asume JSON
const json = JSON.parse(new TextDecoder().decode(bytes));
```
- Si el BOE devuelve una pagina HTML de error, `JSON.parse()` lanza excepcion no controlada

### Lo que NO esta testeado:
- XML malformado o truncado
- Respuestas HTTP que no son JSON
- Fechas fuera de rango (2099, negativos)
- Campos requeridos ausentes en metadata
- Violaciones de integridad referencial
- Problemas de encoding UTF-8
- Documentos muy grandes (memory exhaustion)

---

## 5. Plan de Mejoras por Prioridad

### P0 — Critico (datos incorrectos en produccion)

1. **Validacion Zod en ingest** — Validar JSON antes de insertar en DB
2. **Fix FTS5 duplicados** — DELETE antes de INSERT en norms_fts
3. **Transacciones atomicas** — Envolver cada norm en una transaccion SQLite
4. **Validar respuestas HTTP** — Comprobar Content-Type antes de JSON.parse

### P1 — Alto (calidad de datos)

5. **Quitar date clamping** — Eliminar clamping en `repo.ts`, preservar fechas del BOE fielmente
6. **Deteccion de anomalias en fechas** — Detectar fechas fuera de rango (futuro, pre-1800) y mostrar en pagina de anomalias
7. **Linter automatico** — Ejecutar markdown-linter antes de git commit
8. **Tests para tablas/imagenes** — Fixtures con XML real (fishing_law, international_agreement, corporate_tax)
9. **Mejorar parser de tablas** — Soporte para colspan/rowspan
10. **Logging de warnings** — Tablas vacias, ranks desconocidos, titulos truncados

### P2 — Medio (completitud)

9. **Implementar discoverDaily()** — Endpoint sumario BOE para deteccion de reformas
10. **Tests para edge cases** — XML malformado, encoding, documentos grandes
11. **Checksums de contenido** — Detectar cambios inesperados entre ingestas

### P3 — Bajo (enriquecimiento futuro)

12. **CENDOJ** — Jurisprudencia superpuesta a leyes
13. **EUR-Lex** — Legislacion EU y estado de transposicion
14. **Blame politico** — Departamento/legislatura como autor de reforma
15. **Alertas por tema** — Notificar cambios en leyes de un area

---

## 6. Resumen HN: Lo que la Gente Pide

Del hilo de Legalize (807 puntos), features mas demandados:

1. **Jurisprudencia** — Sentencias superpuestas a las leyes (CENDOJ)
2. **Blame politico** — Quien aprobo cada reforma (Congreso, legislatura, partido)
3. **Grafo de relaciones** — Que leyes referencian a cuales (ya tenemos parcialmente)
4. **Busqueda semantica** — Taxonomia, categorias jerarquicas (tenemos materias)
5. **Tests de contradicciones** — CI para detectar leyes que se contradicen (ingenuo pero interesante con LLM)
6. **Debates parlamentarios** — Enlazar al "por que" de cada reforma
7. **Multi-pais** — Demanda de Alemania, Portugal, Suecia, Finlandia, Holanda, Brasil, Argentina, EEUU

**Nuestras ventajas sobre Legalize:**
- Calidad: pagina de anomalias, deteccion de datos incorrectos del BOE
- Cobertura: 17 CCAA incluidas (Legalize solo estatal)
- Web: busqueda FTS, diffs, timeline (Legalize solo el repo)
- API: REST completa con 15+ endpoints
- Enfoque: citizen-first vs "exploring business"
