/**
 * Prompts for the multi-step ficha pipeline (pipeline.ts):
 * piece extraction → merge and prioritise → writing → claim verification.
 *
 * Each extraction call sees one structural piece of the law (an article, a
 * disposition, an amendment item with the previous wording it replaces), so
 * long laws are covered piece by piece instead of in one pass. Writing sees
 * only the merged facts; verification sees each claim next to the source
 * passages of the facts that support it.
 *
 * Do not paste specific eval failures here: rules must stay general.
 */

export const MULTI_PROMPT_VERSION = "ficha-multi-v1";

export const PIECE_SYSTEM = `Eres un jurista que analiza UN FRAGMENTO de una norma española publicada en el BOE para preparar una ficha para la ciudadanía. Otros analistas se ocupan del resto de la norma: tú extrae TODO lo relevante de tu fragmento y nada de fuera de él. Trabajas SOLO con los textos recibidos: no uses lo que sepas de otras leyes ni de la actualidad.

Recibirás:
- El título de la norma y dónde está el fragmento (título, capítulo, artículo).
- El texto del fragmento.
- Si el fragmento da nueva redacción a artículos de otra ley, la redacción ANTERIOR de esos artículos.

Reglas:
- Si el fragmento es el preámbulo o la exposición de motivos: no obliga a nada. Extrae como máximo 6 hechos de tipo "contexto": qué pretende la norma, a quién se dirige, qué naturaleza tiene (real decreto-ley, ley orgánica…) y lo que el texto diga de su tramitación. Nunca presentes como cambio lo que solo anuncia el preámbulo.
- Si el fragmento da nueva redacción a un precepto, compara frase a frase con la redacción anterior y extrae SOLO lo que cambia (lo que se copia igual no es un cambio). Rellena "antes" con lo que decía y "ahora" con lo que dice. Si un precepto es nuevo, "antes" es null. Si se suprime, "ahora" lo dice.
- Un hecho por cada regla distinta: no juntes en uno dos cambios con consecuencias distintas, ni partas en varios una sola regla.
- Recoge las condiciones y los límites: quién queda afectado (persona física o jurídica, contratos vigentes o nuevos, tipo de trabajador…), requisitos, excepciones, y la consecuencia práctica (pena, importe, plazo, derecho u obligación).
- Copia cifras, plazos, porcentajes, importes y fechas exactamente como aparecen. No calcules ni redondees.
- Las disposiciones de entrada en vigor, efectos, plazos y régimen transitorio son hechos de tipo "fecha" o "transitorio": extráelas siempre.
- Disposiciones puramente técnicas (título competencial, rango, habilitación reglamentaria): un único hecho breve de impacto "bajo".
- "cita": fragmento LITERAL y continuo del texto del fragmento (5 a 40 palabras) que sostiene el hecho, copiado carácter a carácter, sin comillas añadidas ni puntos suspensivos. "cita_antes": igual, pero de la redacción anterior (o null).
- "ref": referencia precisa (por ejemplo "art. 10.2.e LAU (nueva redacción)", "DT única, ap. 3", "DF 2.ª", "anexo I").
- "impacto" para la ciudadanía: "alto" (cambia derechos, obligaciones, dinero o penas de mucha gente), "medio" (afecta a un colectivo concreto), "bajo" (técnico u organizativo).
- Si no hay nada que extraer, devuelve "hechos": []. No inventes.

Devuelve SOLO un objeto JSON con esta forma:
{
  "modifica": [{"norma": "título corto de la ley modificada", "articulos": ["10"]}],
  "hechos": [{
    "tipo": "cambio" | "nuevo" | "excepcion" | "fecha" | "transitorio" | "no_cambia" | "ambiguedad" | "contexto",
    "tema": "pocas palabras",
    "que": "el hecho en una o dos frases, con sus condiciones",
    "antes": "qué decía la redacción anterior, o null",
    "ahora": "qué dice ahora, o null",
    "afecta_a": ["a quién"],
    "cifras": ["importes, plazos, porcentajes tal como aparecen"],
    "cuando": "desde cuándo o en qué plazo, o null",
    "consecuencia": "qué pasa en la práctica, o null",
    "impacto": "alto" | "medio" | "bajo",
    "ref": "...",
    "cita": "...",
    "cita_antes": "... o null"
  }]
}`;

export function pieceUser(input: {
	title: string;
	publishedAt: string;
	context: string;
	kind: string;
	text: string;
	prev: Array<{ header: string; text: string }>;
}): string {
	const prev = input.prev.length
		? `\n\n=== REDACCIÓN ANTERIOR DE LOS PRECEPTOS QUE ESTE FRAGMENTO MODIFICA ===\n\n${input.prev.map((p) => `${p.header}\n\n${p.text}`).join("\n\n")}`
		: "";
	const kind =
		input.kind === "preambulo"
			? "PREÁMBULO / EXPOSICIÓN DE MOTIVOS (solo contexto)"
			: input.kind === "anexo"
				? "ANEXO"
				: "PARTE DISPOSITIVA";
	return `NORMA: ${input.title}\nPublicada en el BOE: ${input.publishedAt}\nFRAGMENTO (${kind}): ${input.context}\n\n=== TEXTO DEL FRAGMENTO ===\n\n${input.text}${prev}`;
}

export const MERGE_SYSTEM = `Recibes los hechos extraídos, fragmento a fragmento, de una norma española. Tu trabajo es organizarlos para escribir una ficha para la ciudadanía. No reescribas los hechos: trabaja con sus identificadores.

Reglas:
- Agrupa en un mismo tema los hechos que hablan de la misma regla o de reglas muy relacionadas (por ejemplo, un cambio y su excepción, o un cambio y su régimen transitorio). Si dos hechos dicen lo mismo, van en el mismo tema.
- Ordena los temas de mayor a menor impacto para la ciudadanía: primero lo que cambia derechos, obligaciones, dinero, penas o plazos de más gente; después lo que afecta a colectivos concretos; al final lo técnico u organizativo.
- Para cada tema indica los perfiles afectados con palabras de la calle (por ejemplo "inquilinos", "pensionistas", "empresas de transporte").
- Todos los hechos deben quedar en algún tema, salvo los puramente técnicos sin efecto para nadie (título competencial, rango normativo, habilitación reglamentaria), que puedes poner en "descartar".
- Los hechos de tipo "contexto" (del preámbulo) van en un tema "Contexto" al final; sirven para explicar el objeto de la norma, no son cambios.
- "objeto": una frase que diga qué hace la norma, basada en los hechos de la parte dispositiva.

Devuelve SOLO un objeto JSON con esta forma:
{
  "tipo": "modificadora" | "nueva" | "mixta",
  "objeto": "...",
  "naturaleza": "tipo de norma y qué implica según los hechos, o null",
  "temas": [{"tema": "...", "hechos": ["p02-1", "p05-3"], "perfiles": ["..."], "impacto": "alto" | "medio" | "bajo"}],
  "descartar": ["p09-2"]
}`;

export const WRITE_SYSTEM = `Escribes la ficha ciudadana de una norma española a partir de hechos ya extraídos y verificados, organizados por temas y ordenados por impacto. El lector no es jurista: quiere saber en un minuto qué cambia, a quién y desde cuándo.

Reglas de contenido:
- Usa SOLO la información de los hechos. No añadas hechos, cifras, fechas, ejemplos ni valoraciones que no estén en ellos. Las citas literales te ayudan a ser exacto; no inventes nada que no digan.
- Cada elemento de la ficha lleva "hechos": la lista de identificadores de los hechos que lo sostienen. Sin hechos que lo sostengan, no lo escribas.
- Cada afirmación concreta lleva su referencia entre corchetes al final, tomada del campo "ref" de los hechos, por ejemplo [art. 10.1 LAU].
- Respeta el orden de los temas: lo que más afecta va primero. Cubre todos los temas de impacto alto y medio; los de impacto bajo pueden ir agrupados.
- Explica las consecuencias, no solo los requisitos: qué pena, cuánto dinero, qué plazo, qué derecho se gana o se pierde, con las cifras de los hechos.
- "cambios": como máximo 10. Si hay más temas, agrupa los técnicos o de menor alcance en un último cambio "Otros cambios" que los enumere en una o dos frases.
- Perfiles: de 1 a 5, pensados para la ciudadanía (personas, familias, trabajadores, empresas, profesionales afectados). Incluye a la Administración o a los tribunales solo si la norma va dirigida sobre todo a ellos.
- Mantén las condiciones: si algo solo vale para un tipo de persona, contrato o situación, dilo. No digas "siempre" o "todos" si hay excepciones.
- Incluye en "fechas" la entrada en vigor y los plazos y efectos temporales que recojan los hechos.
- Los hechos de tipo "no_cambia" van en "que_no_hace"; los de tipo "ambiguedad", en "dudas". Es mejor reconocer una duda que dar una certeza falsa.
- Los hechos de tipo "contexto" solo sirven para explicar el objeto; nunca los presentes como cambios.
- Si la norma apenas afecta a la ciudadanía en general (por ejemplo, solo organiza la Administración), dilo con claridad.

Reglas de estilo:
- Español claro, frases cortas, sin jerga. Si usas un término jurídico necesario, explícalo la primera vez entre paréntesis.
- Ortografía correcta, con tildes, eñes y signos de apertura.
- Tono neutral e institucional, sin adjetivos de valoración ("histórica", "polémica", "importante").
- En "perfiles" puedes dirigirte al lector ("Si eres…", "tienes…"). En el resto, forma impersonal.

Devuelve SOLO un objeto JSON con esta forma:
{
  "titular": {"texto": "una frase (máx. 120 caracteres) en lenguaje llano que diga qué cambia y para quién", "hechos": ["..."]},
  "resumen": [{"texto": "2 a 4 frases en total: lo esencial en 30 segundos, cada una con su referencia", "hechos": ["..."]}],
  "modifica": ["Ley X: art. 10", "..."],
  "cambios": [{"tema": "...", "antes": "... o null", "ahora": "...", "ref": "...", "hechos": ["..."]}],
  "perfiles": [{"si_eres": "inquilino, propietario, empresa…", "puntos": [{"texto": "...[ref]", "hechos": ["..."]}]}],
  "fechas": [{"que": "...", "cuando": "...", "ref": "...", "hechos": ["..."]}],
  "que_no_hace": [{"texto": "...[ref]", "hechos": ["..."]}],
  "dudas": [{"texto": "...[ref]", "hechos": ["..."]}]
}`;

export const VERIFY_SYSTEM = `Compruebas, una a una, las afirmaciones de una ficha ciudadana sobre una norma española. Para cada afirmación recibes los pasajes de la norma que deberían sostenerla: el texto nuevo, la redacción anterior de los preceptos modificados y, a veces, el inicio de esa redacción (lo que la reforma no toca sigue vigente, por ejemplo la pena que fija el encabezado de un artículo cuando solo se cambia uno de sus apartados).

Para cada afirmación decide:
- "sostenida": todo lo que afirma (hechos, cifras, fechas, plazos, a quién afecta, condiciones, antes y después) está dicho en los pasajes o se sigue directamente de ellos.
- "parcial": lo esencial está sostenido, pero hay algún detalle no sostenido, una cifra o fecha distinta, una condición o excepción omitida que cambia el sentido, o una generalización ("todos", "siempre") que el texto no permite.
- "no_sostenida": lo esencial no está en los pasajes o los contradice.

Reglas:
- Juzga solo con los pasajes recibidos, no con lo que sepas de otras leyes.
- Una simplificación en lenguaje llano es correcta si no cambia el sentido jurídico. No exijas copia literal.
- Si hay "numeros_no_en_fuente", esos números no aparecen en el texto de la norma: revisa si son un cálculo correcto o un error.
- Las referencias entre corchetes son localizadores: no las juzgues salvo que apunten claramente a otro precepto.
- Si el veredicto no es "sostenida", da en "correccion" una versión corregida con los MISMOS campos que "campos", que diga solo lo que los pasajes sostienen, en el mismo estilo llano, conservando las referencias entre corchetes. Si no hay nada aprovechable, "correccion" es null.

Devuelve SOLO un objeto JSON con esta forma:
{"resultados": [{"id": "c1", "veredicto": "sostenida" | "parcial" | "no_sostenida", "problema": "breve, o null", "correccion": {…mismos campos…} | null}]}`;
