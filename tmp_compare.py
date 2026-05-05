import sqlite3
import json
import subprocess

DB = "data/leyabierta.db"

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Get 5 articles with Gemini summaries and their full text
# Note: need to join on BOTH norm_id AND block_id to avoid duplicates
cur.execute("""
    SELECT c.norm_id, c.block_id, c.summary as gemini_summary, b.current_text
    FROM citizen_article_summaries c
    JOIN blocks b ON c.block_id = b.block_id AND c.norm_id = b.norm_id
    LIMIT 5
""")
articles = cur.fetchall()
conn.close()

SYSTEM_PROMPT = """Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

**REGISTRO OBLIGATORIO — TERCERA PERSONA:**
El resumen SIEMPRE debe escribirse en tercera persona. PROHIBIDO usar segunda persona (tú, tu, tienes, puedes, te, le, les). Usa construcciones impersonales o de tercera persona:
- ✅ "El ciudadano tiene derecho a..." / "La persona investigada puede solicitar..." / "Se establece que..."
- ✅ "Los funcionarios que falseen..." / "Las sanciones se gradúan..."
- ❌ "Tienes derecho a..." / "Puedes ejercer..." / "tus datos personales"
- ❌ "Usted tiene derecho a..." (tampoco, usa tercera persona)

**NO AÑADIR COMENTARIOS EDITORIALES:**
El resumen debe contener ÚNICAMENTE información presente en el artículo original. PROHIBIDO:
- Añadir frases de conclusión o interpretación que no estén en el texto
- Añadir análisis, opiniones, o contexto externo
- Parafasear de forma que cambie el significado

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: Resumen de máximo 280 caracteres. Lenguaje claro y serio, sin jerga legal. Con acentos correctos. Incluye los datos concretos más relevantes (plazos, requisitos, cantidades) cuando los haya.

**LONGITUD OBLIGATORIA:** El resumen debe ser estrictamente menor de 280 caracteres. Si excedes, acorta sin perder el dato central. Un resumen de 150-250 caracteres es ideal.

**PROHIBIDO:** NO añadas frases de relleno como "Consulte la normativa vigente", "Para más información", "Recuerde que...", o cualquier advertencia no presente en el artículo original. Solo resume lo que dice el artículo.

**CUÁNDO DEVOLVER VACÍO (SOLO estos casos):**
Devuelve citizen_summary vacío Y SOLO si el artículo es una de estas cosas:
  1. Declara la entrada en vigor de la norma (ej. "Esta ley entrará en vigor el día siguiente al de su publicación").
  2. Deroga o modifica otra norma (ej. "Se deroga el artículo X de la Ley Y").
  3. Asigna rango de ley orgánica a algo.
  4. Contenido puramente organizativo interno sin efecto sobre derechos u obligaciones ciudadanas.

**IMPORTANTE — Los siguientes SÍ requieren resumen (genera SIEMPRE):**
- Artículos que describen procedimientos, reglas de funcionamiento, composición de órganos, requisitos administrativos, plazos, competencias, o cualquier contenido sustantivo.
- Artículos sobre financiación, presupuestos, organización de organismos públicos.
- En caso de duda, genera siempre un resumen breve. Es mejor un resumen corto que ninguno. Nunca devuelvas vacío por duda.

**FORMATO DE PENSAMIENTO INTERNO (obligatorio):**
Antes de generar el JSON, piensa brevemente en este formato EXACTO:
<think>
OBJETIVO: [1 frase: qué derecho u obligación describe este artículo]
HECHOS: [datos concretos: plazos, cantidades, requisitos — solo lo que dice el artículo]
ETIQUETAS: [3-5 palabras clave en llano]
RESUMEN: [borrador de 1 línea en 3ª persona]
VERIFICACIÓN: [¿uso 3ª persona? ¿añado algo que no está en el artículo? ¿este artículo SÍ merece resumen?]
</think>

NO escribas razonamiento extenso. NO inventes datos. Si un dato no está en el artículo, no lo inventes. El output debe ser SOLO el JSON, sin texto adicional.

**EJEMPLOS (estudia cada uno cuidadosamente):**

Ejemplo 1 (composición de órgano — SÍ resumen, NO vacío):
ARTÍCULO: El Consejo de Administración estará compuesto por un mínimo de cinco y un máximo de quince miembros, nombrados por el Consejo de Gobierno por un período de cuatro años, con posibilidad de reelegirles.
RESUMEN: El Consejo de Administración tiene entre 5 y 15 miembros, nombrados por el Consejo de Gobierno por 4 años con posibilidad de reelección.

Ejemplo 2 (plazos de prescripción — SÍ resumen, NO vacío):
ARTÍCULO: Las infracciones muy graves prescribirán a los tres años, las graves a los dos y las leves a los doce meses, contado desde el día en que se cometió la infracción.
RESUMEN: Las infracciones prescriben en: 3 años (muy graves), 2 años (graves), 12 meses (leves), desde la fecha de la infracción.

Ejemplo 3 (procedimiento administrativo — SÍ resumen, NO vacío):
ARTÍCULO: La solicitud de beca deberá presentarse en el registro del organismo competente junto con la documentación acreditativa de los requisitos económicos y académicos en el plazo del 1 de marzo al 30 de junio.
RESUMEN: La solicitud de beca debe presentarse en el registro del organismo competente, con documentación acreditativa, del 1 de marzo al 30 de junio.

Ejemplo 4 (entrada en vigor — vacío SÍ es correcto):
ARTÍCULO: Esta ley entrará en vigor el día siguiente al de su publicación en el Boletín Oficial del Estado.
RESUMEN: _(vacío)_

Ejemplo 5 (derechos procesales — SÍ resumen, NO vacío):
ARTÍCULO: La defensa de una persona investigada podrá solicitar que se practiquen diligencias de investigación que complementen las ya practicadas. El Fiscal Europeo acordará las diligencias si son relevantes para la investigación. Si las deniega, se podrán impugnar ante el Juez de Garantías.
RESUMEN: La persona investigada puede solicitar diligencias complementarias. El Fiscal Europeo las acordará si son relevantes. La denegación se puede impugnar ante el Juez de Garantías."""

print("=" * 80)
print("QWEN vs GEMINI COMPARISON")
print("=" * 80)

for i, a in enumerate(articles):
    norm_id = a["norm_id"]
    block_id = a["block_id"]
    gemini_summary = a["gemini_summary"]
    current_text = a["current_text"]
    
    print(f"\n{'='*80}")
    print(f"ARTÍCULO {i+1}: {norm_id} :: {block_id}")
    print(f"{'='*80}")
    print(f"\nTexto del artículo (primeras 500 chars):")
    print(current_text[:500])
    print(f"\nGemini: {gemini_summary}")
    
    # Call Qwen API
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", 
             "https://api.nan.builders/v1/chat/completions",
             "-H", "Authorization: Bearer sk-1WqPsfFrl3YHyBg52xRvTg",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({
                 "model": "qwen3.6",
                 "messages": [
                     {"role": "system", "content": SYSTEM_PROMPT},
                     {"role": "user", "content": f"ARTÍCULO:\n{current_text[:2000]}"}
                 ],
                 "temperature": 0.2,
                 "max_tokens": 32000,
                 "response_format": {
                     "type": "json_schema",
                     "json_schema": {
                         "name": "citizen_metadata",
                         "strict": True,
                         "schema": {
                             "type": "object",
                             "properties": {
                                 "citizen_tags": {"type": "array", "items": {"type": "string"}},
                                 "citizen_summary": {"type": "string"}
                             },
                             "required": ["citizen_tags", "citizen_summary"],
                             "additionalProperties": False
                         }
                     }
                 }
             })
            ],
            capture_output=True,
            text=True,
            timeout=60
        )
        data = json.loads(result.stdout)
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        # Parse JSON from content
        parsed = json.loads(content.replace("```json\n", "").replace("```", "").strip())
        qwen_summary = parsed.get("citizen_summary", "(parse error)")
        qwen_tags = parsed.get("citizen_tags", [])
        
        print(f"\nQwen: {qwen_summary}")
        print(f"Qwen tags: {', '.join(qwen_tags)}")
        
        # Quality comparison
        gemini_len = len(gemini_summary) if gemini_summary else 0
        qwen_len = len(qwen_summary) if qwen_summary else 0
        
        print(f"\n--- Comparación ---")
        print(f"Gemini length: {gemini_len} chars | Qwen length: {qwen_len} chars")
        
        # Check for common issues
        issues = []
        if not qwen_summary:
            issues.append("EMPTY (should not be)")
        if len(qwen_summary) > 280:
            issues.append(f"TOO LONG ({len(qwen_summary)} chars)")
        if "tú" in qwen_summary.lower() or "tu " in qwen_summary.lower() or "puedes" in qwen_summary.lower():
            issues.append("USES 2ND PERSON (bad)")
        if "consulte" in qwen_summary.lower() or "recuerde" in qwen_summary.lower():
            issues.append("HAS FILLER PHRASES")
        
        if issues:
            print(f"ISSUES: {', '.join(issues)}")
        else:
            print("✓ No issues detected")
            
    except Exception as e:
        print(f"\nQwen ERROR: {e}")
