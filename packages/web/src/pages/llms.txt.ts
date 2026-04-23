/**
 * llms.txt — LLM-optimized site description generated at build time.
 * Follows the llms.txt convention (https://llmstxt.org/).
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const totalLaws = laws.length.toLocaleString("es-ES");
	const jurisdictions = new Set(laws.map((l) => l.data.jurisdiccion));
	const jurisdictionCount = jurisdictions.size;

	const body = `# Ley Abierta

> Motor open source que convierte legislación oficial en archivos Markdown versionados con Git, y los expone a través de una API y web para que cualquier ciudadano pueda buscar, comparar versiones y entender cómo cambian las leyes que le afectan.

## Datos
- Más de ${totalLaws} leyes consolidadas desde 1835 hasta hoy
- ${jurisdictionCount} jurisdicciones: España (estatal) + 17 comunidades autónomas
- Fuente oficial: Agencia Estatal Boletín Oficial del Estado (BOE)

## Páginas principales
- [Inicio](https://leyabierta.es/): Buscador de leyes, estadísticas, últimas reformas
- [Cambios legislativos](https://leyabierta.es/cambios/): Cronología de reformas recientes con resúmenes
- [Leyes ómnibus](https://leyabierta.es/omnibus/): Detección de leyes que modifican múltiples normas
- [Alertas](https://leyabierta.es/alertas/): Suscripción a notificaciones por temas y jurisdicción
- [Sobre Ley Abierta](https://leyabierta.es/sobre-leyabierta/): Misión, datos, metodología

## API REST
- [Buscar leyes](https://api.leyabierta.es/v1/laws?q=): Búsqueda por texto, rango, estado, materia, jurisdicción
- [Rangos normativos](https://api.leyabierta.es/v1/ranks): Tipos de norma con conteos
- [Materias](https://api.leyabierta.es/v1/materias): Categorías temáticas con conteos
- [Changelog](https://api.leyabierta.es/v1/changelog): Últimas reformas con resúmenes IA
- [Health](https://api.leyabierta.es/health): Estado del servicio

## Código fuente
- [GitHub](https://github.com/leyabierta/leyabierta): Código fuente del proyecto (AGPL-3.0)
- [Repo de leyes](https://github.com/leyabierta/leyes): Legislación como Markdown + historial Git

## Optional
- [Documentación completa para LLMs](https://leyabierta.es/llms-full.txt): API reference completa con cobertura de jurisdicciones y rangos
- [RSS](https://leyabierta.es/feed.xml): Feed de reformas recientes
- [Sitemap](https://leyabierta.es/sitemap.xml): Mapa del sitio
- [Privacidad](https://leyabierta.es/privacidad/): Política de privacidad
- [Aviso legal](https://leyabierta.es/aviso-legal/): Aviso legal y atribución
`;

	return new Response(body, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
};
