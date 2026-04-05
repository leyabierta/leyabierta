# TODOS

## P1 — Follow-up inminente

### Auto-detect omnibus en pipeline de ingest
Cuando se importan nuevas normas del BOE, auto-generar omnibus topics si materia_count >= 15.
Sin esto, la feature de ómnibus se queda estática (solo las 959 normas del backfill inicial).
- Trigger: post-ingest hook o cron que detecta normas sin omnibus_topics con 15+ materias
- Reusa generate-omnibus-topics.ts existente
- Effort: M (human) → S (CC)
- Depends on: backfill completo (Phase 8 del CEO plan personalizacion-omnibus-v2)

## P2

### Contador público en landing
Stat en la homepage: "N temas no relacionados con el título detectados este año".
Genera curiosidad y comunica la propuesta de valor de la detección de ómnibus.
- Requires: backfill completo
- Effort: S (human) → S (CC)
- Files: packages/web/src/pages/index.astro, packages/api/src/services/db.ts

## P3

### Share cards para temas no relacionados
Deep link /omnibus/[normId]#topic-[index] con OG tags específicos por topic.
"Tema no relacionado con el título: Reforma del IRPF dentro de un decreto de catástrofes."
Potencial viral en redes.
- Requires: ruta server-side para OG tags dinámicos, o build-time generation
- Effort: M (human) → S (CC)
- Files: packages/web/src/pages/omnibus/[id].astro, packages/api/src/routes/omnibus.ts
