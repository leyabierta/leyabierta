/**
 * llms-full.txt — Extended LLM-optimized site description with full API
 * reference and data coverage details. Generated at build time.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

/** Display names for jurisdiction codes */
const JURISDICTION_LABELS: Record<string, string> = {
	es: "España (estatal)",
	"es-ct": "Cataluña",
	"es-pv": "País Vasco",
	"es-an": "Andalucía",
	"es-ga": "Galicia",
	"es-md": "Comunidad de Madrid",
	"es-vc": "Comunitat Valenciana",
	"es-ar": "Aragón",
	"es-cl": "Castilla y León",
	"es-cm": "Castilla-La Mancha",
	"es-cn": "Canarias",
	"es-ex": "Extremadura",
	"es-ib": "Illes Balears",
	"es-ri": "La Rioja",
	"es-na": "Navarra",
	"es-as": "Asturias",
	"es-cb": "Cantabria",
	"es-mc": "Región de Murcia",
};

/** Format a number with Spanish locale (dots as thousands separator) */
function fmt(n: number): string {
	return n.toLocaleString("es-ES");
}

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const totalLaws = fmt(laws.length);
	const jurisdictions = new Set(laws.map((l) => l.data.jurisdiccion));
	const jurisdictionCount = jurisdictions.size;

	// Jurisdiction counts
	const jurisdictionCounts = new Map<string, number>();
	for (const law of laws) {
		const j = law.data.jurisdiccion;
		jurisdictionCounts.set(j, (jurisdictionCounts.get(j) ?? 0) + 1);
	}
	const jurisdictionLines = [...jurisdictionCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([code, count]) => {
			const label = JURISDICTION_LABELS[code] ?? code;
			return `- ${label} (${code}): ${fmt(count)} leyes`;
		})
		.join("\n");

	// Rank counts
	const rankCounts = new Map<string, number>();
	for (const law of laws) {
		const r = law.data.rango ?? "desconocido";
		rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
	}
	const rankLines = [...rankCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([rank, count]) => `- ${rank}: ${fmt(count)}`)
		.join("\n");

	// Temporal coverage
	let earliest = "9999-12-31";
	let latest = "0000-01-01";
	for (const law of laws) {
		const pub = law.data.fecha_publicacion;
		const upd = law.data.ultima_actualizacion;
		if (pub && pub < earliest) earliest = pub;
		if (upd && upd > latest) latest = upd;
	}

	const body = `# Ley Abierta — Documentación completa

> Motor open source que convierte legislación oficial en archivos Markdown versionados con Git, y los expone a través de una API y web para que cualquier ciudadano pueda buscar, comparar versiones y entender cómo cambian las leyes que le afectan.

## Datos
- Más de ${totalLaws} leyes consolidadas desde 1835 hasta hoy
- ${jurisdictionCount} jurisdicciones: España (estatal) + 17 comunidades autónomas
- Fuente oficial: Agencia Estatal Boletín Oficial del Estado (BOE)

## Cobertura

### Jurisdicciones
${jurisdictionLines}

### Rangos normativos
${rankLines}

### Cobertura temporal
- Ley más antigua: ${earliest}
- Última actualización: ${latest}

## Páginas principales
- [Inicio](https://leyabierta.es/): Buscador de leyes, estadísticas, últimas reformas
- [Cambios legislativos](https://leyabierta.es/cambios/): Cronología de reformas recientes con resúmenes
- [Leyes ómnibus](https://leyabierta.es/cambios/omnibus/): Detección de leyes que modifican múltiples normas
- [Alertas](https://leyabierta.es/alertas/): Suscripción a notificaciones por temas y jurisdicción
- [Sobre Ley Abierta](https://leyabierta.es/sobre-leyabierta/): Misión, datos, metodología

## API REST — Referencia completa

### Buscar leyes
\`GET /v1/laws\`

Parámetros:
- \`q\` (string): Texto de búsqueda (búsqueda full-text)
- \`country\` (string): Código de país (ej: "es")
- \`rank\` (string): Tipo de rango normativo (ej: "ley", "real_decreto")
- \`status\` (string): Estado de vigencia ("vigente", "derogado")
- \`materia\` (string): Categoría temática
- \`jurisdiction\` (string): Jurisdicción (ej: "es", "es-ct" para Cataluña)
- \`limit\` (number): Resultados por página (default: 20)
- \`offset\` (number): Desplazamiento para paginación

### Obtener una ley
\`GET /v1/laws/:id\`

Devuelve la ley completa con metadatos, artículos y reformas.

### Artículo específico
\`GET /v1/laws/:id/articles/:n\`

Artículo por posición con todas sus versiones históricas.

### Historial de reformas
\`GET /v1/laws/:id/history\`

Línea temporal de reformas con títulos de artículos afectados.

### Comparar versiones (diff)
\`GET /v1/laws/:id/diff?from=YYYY-MM-DD&to=YYYY-MM-DD\`

Diff unificado entre dos fechas.

### Versión en fecha concreta
\`GET /v1/laws/:id/versions/YYYY-MM-DD\`

Texto completo de la ley tal como era en una fecha específica.

### Análisis
\`GET /v1/laws/:id/analisis\`

Materias, notas y referencias cruzadas.

### Grafo de relaciones
\`GET /v1/laws/:id/graph\`

Datos del grafo de relaciones entre normas.

### Rangos normativos
\`GET /v1/ranks\`

Tipos de rango (constitución, ley orgánica, ley, real decreto, etc.) con conteos.

### Materias
\`GET /v1/materias\`

Categorías temáticas con conteos.

### Changelog
\`GET /v1/changelog?jurisdiction=es&since=2024-01-01&limit=50\`

Reformas recientes con resúmenes generados por IA.

### Reformas personalizadas
\`GET /v1/reforms/personal?materias=IRPF,Empleo&jurisdiction=es-vc\`

Reformas filtradas por materias y jurisdicción del usuario.

### Leyes ómnibus
\`GET /v1/omnibus\` — Lista de leyes ómnibus recientes
\`GET /v1/omnibus/:normId\` — Detalle con desglose por temas

## Formato de datos

Cada ley tiene frontmatter YAML con:
- \`titulo\`: Título de la norma
- \`identificador\`: ID único (ej: "BOE-A-1978-31229")
- \`pais\`: Código de país
- \`jurisdiccion\`: Jurisdicción (ej: "es", "es-ct")
- \`rango\`: Tipo de norma
- \`fecha_publicacion\`: Fecha de publicación original (ISO 8601)
- \`ultima_actualizacion\`: Fecha de última reforma
- \`estado\`: "vigente" o "derogado"
- \`departamento\`: Órgano emisor
- \`fuente\`: URL al BOE
- \`articulos\`: Número de artículos
- \`reformas\`: Lista de reformas con fecha y fuente
- \`materias\`: Categorías temáticas
- \`referencias_posteriores\`: Normas que modifican o desarrollan esta ley

## Atribución
Fuente de datos: Agencia Estatal Boletín Oficial del Estado (boe.es). Contenido legislativo en dominio público. Código fuente bajo licencia AGPL-3.0.

## Código fuente
- [GitHub](https://github.com/leyabierta/leyabierta): Código fuente del proyecto (AGPL-3.0)
- [Repo de leyes](https://github.com/leyabierta/leyes): Legislación como Markdown + historial Git

## Optional
- [RSS](https://leyabierta.es/feed.xml): Feed de reformas recientes
- [Sitemap](https://leyabierta.es/sitemap.xml): Mapa del sitio
- [Privacidad](https://leyabierta.es/privacidad/): Política de privacidad
- [Aviso legal](https://leyabierta.es/aviso-legal/): Aviso legal y atribución
`;

	return new Response(body, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
};
