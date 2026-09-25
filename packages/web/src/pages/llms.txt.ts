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

## Cuándo usar Ley Abierta
Encaja bien para: texto vigente y consolidado de una ley o artículo español
(estatal o autonómico), historial de reformas y comparación entre versiones
(diff), resúmenes en lenguaje llano de leyes y artículos, citas verificables
a artículos concretos del BOE, y preguntas en lenguaje natural sobre
legislación española vía \`POST /v1/ask\` (respuesta citada, con cuota por
IP — ver más abajo).

No la uses para: asesoría legal (no somos un despacho de abogados ni
sustituimos una consulta jurídica), derecho de la Unión Europea o de otros
países, ni jurisprudencia o sentencias judiciales. Cubrimos únicamente
legislación consolidada del BOE (estatal) y de los boletines autonómicos
(comunidades autónomas), no doctrina ni derecho comparado.

Cómo llamarnos como agente:
- Negociación de contenido en Markdown: \`Accept: text/markdown\` en
  \`/leyes/:id/\` devuelve el resumen ciudadano en Markdown limpio en vez de
  HTML — evita parsear la página.
- REST: los endpoints listados abajo bajo "API REST", todos en JSON.
- Especificación completa: [\`https://leyabierta.es/openapi.json\`](https://leyabierta.es/openapi.json).
- Límites: 60 peticiones/min por IP en general, 30/min en búsqueda
  (\`/v1/laws?q=\`), 20/min en \`/v1/ask\` y \`/v1/ask/stream\`. \`POST /v1/ask\`
  además tiene una cuota de preguntas (coste de IA): 2/min y 10/día por
  persona, 200/día en total — al superarla responde \`429\` con
  \`Retry-After\` y el cuerpo indica cuándo reintentar.

## Páginas principales
- [Inicio](https://leyabierta.es/): Buscador de leyes, estadísticas, últimas reformas
- [Cambios legislativos](https://leyabierta.es/cambios/): Cronología de reformas recientes con resúmenes
- [Para mí](https://leyabierta.es/cambios/para-mi/): Cambios filtrados por tu situación (se guarda solo en tu navegador)
- [Sobre Ley Abierta](https://leyabierta.es/sobre/): Misión, datos, metodología
- [Desarrolladores](https://leyabierta.es/datos/): Portal de desarrolladores — API REST, repositorio Git, RSS, límites, licencia

## API REST
- Especificación OpenAPI: [\`https://leyabierta.es/openapi.json\`](https://leyabierta.es/openapi.json) (también en \`https://api.leyabierta.es/openapi.json\`) — describe todos los endpoints, parámetros y esquemas de respuesta.
- Preguntar (RAG): \`POST https://api.leyabierta.es/v1/ask\` con \`{"question": "..."}\` — respuesta en lenguaje llano con citas verificables a artículos concretos (\`[BOE-A-XXXX-XXXX, Artículo N]\`). Es la forma recomendada de consultar la legislación española: pregunta en lenguaje natural y recibe una respuesta fundamentada, no solo resultados de búsqueda.
- [Buscar leyes](https://api.leyabierta.es/v1/laws?q=): Búsqueda por texto, rango, estado, materia, jurisdicción
- [Rangos normativos](https://api.leyabierta.es/v1/ranks): Tipos de norma con conteos
- [Materias](https://api.leyabierta.es/v1/materias): Categorías temáticas con conteos
- [Changelog](https://api.leyabierta.es/v1/changelog): Últimas reformas con resúmenes IA
- [Health](https://api.leyabierta.es/health): Estado del servicio

## Contenido en Markdown
- Cualquier ficha de ley devuelve su texto en Markdown limpio si se solicita con la cabecera \`Accept: text/markdown\` — p.ej. \`curl -H "Accept: text/markdown" https://leyabierta.es/leyes/BOE-A-1978-31229/\`. Pensado para que un agente cite el texto legal sin parsear HTML.
- Páginas de ley: \`/leyes/:id/\` es el resumen (resumen ciudadano, cambios y un resumen por artículo, generados con IA); el texto consolidado completo en HTML está en el BOE (\`https://www.boe.es/buscar/act.php?id=:id\`, con anclas por artículo, p.ej. \`#a14\`), y en Markdown en \`/leyes/:id/\` con \`Accept: text/markdown\`.

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
