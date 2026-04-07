# TODOS

Items pendientes para Ley Abierta. Si quieres contribuir, abre un issue o un PR referenciando el item.

## En curso — Polish & Distribute (v0.2)

Objetivo: preparar el producto para distribución. SEO, accesibilidad, homepage ciudadana.

### Homepage ciudadana
- [x] Reemplazar "Cambios recientes" con `citizen_summary` en vez de títulos legales del BOE
- [x] Reemplazar "Leyes que más han cambiado" con formato "¿Sabías que...?" (datos curiosos legislativos)
- [x] Hacer más prominente el CTA "Descubre qué leyes te afectan"
- [x] Extender `getRecentlyUpdated()` en `db.ts` para devolver `citizen_summary`

### SEO y distribución
- [x] Auditoría completa de meta tags, OG tags y canonical URLs en todas las páginas
- [x] OG images dinámicas por ley (Satori, top 2000 leyes + reformadas últimos 6 meses)
- [x] JSON-LD structured data (`schema.org/Legislation`) en cada página de ley
- [ ] Verificar sitemap.xml y robots.txt

### API
- [x] Mejorar Swagger: descripciones ricas, tags por grupo, ejemplos de respuesta
- [x] Añadir contacto + enlace a GitHub en config de Swagger

### Web — recursos y footer
- [x] Actualizar `/sobre-leyabierta` con enlaces a API (Swagger), RSS feeds, CONTRIBUTING.md
- [x] Añadir enlaces a API y RSS en el footer global

### QA
- [ ] Auditoría de accesibilidad WCAG 2.1 AA (contraste, teclado, aria-labels, focus)
- [ ] Lighthouse en páginas principales (objetivo: >=90 en Accesibilidad, SEO, Best Practices)
- [ ] Testing responsive: 375px (iPhone SE), 768px (iPad), 1440px (desktop)

---

## Diferido — Ideas para el futuro

### Share cards para temas no relacionados
Deep links + OG tags específicos para compartir. La limitación actual es que CLoudflare Pages solo soporta 20k pages  y tenemos 12k , si cada OG tag crease 1 mas, nos pasamos.

### User testing (Mom Test)
Enviar leyabierta.es a 5-10 personas no técnicas. Observar si completan el wizard, entienden el changelog, y se suscribirían. Criterio del design doc original.
