#!/usr/bin/env python3
"""
A/B Test: Qwen 3.6 vs Gemini for citizen summaries
- 100 articles from diverse norms
- Metrics: empty rate, length, 3rd person compliance, filler phrases, content richness
- Runs in parallel batches of 5
"""

import sqlite3
import json
import subprocess
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

DB = "data/leyabierta.db"
API_KEY = "sk-1WqPsfFrl3YHyBg52xRvTg"
BASE_URL = "https://api.nan.builders/v1"

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


def get_articles_from_db(n=100):
    """Get diverse articles from different norms and jurisdictions."""
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Get articles from diverse sources: different norms, different jurisdictions
    cur.execute("""
        SELECT n.id AS norm_id, n.title AS norm_title, n.country, n.rank,
               b.block_id, b.block_type, b.title AS block_title, b.current_text,
               c.summary AS gemini_summary
        FROM norms n
        JOIN blocks b ON b.norm_id = n.id
        LEFT JOIN citizen_article_summaries c ON c.norm_id = n.id AND c.block_id = b.block_id
        WHERE n.status = 'vigente'
          AND b.block_type = 'precepto'
          AND length(b.current_text) BETWEEN 200 AND 2000
          AND NOT EXISTS (
            SELECT 1 FROM citizen_article_summaries c2
            WHERE c2.norm_id = n.id AND c2.block_id = b.block_id
          )
        ORDER BY RANDOM()
        LIMIT ?
    """, (n,))
    
    articles = cur.fetchall()
    conn.close()
    return articles


def call_qwen(article):
    """Call Qwen API for a single article."""
    norm_id = article["norm_id"]
    block_id = article["block_id"]
    current_text = article["current_text"]
    
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST",
             f"{BASE_URL}/chat/completions",
             "-H", f"Authorization: Bearer {API_KEY}",
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
             }),
            ],
            capture_output=True,
            text=True,
            timeout=180
        )
        
        if result.returncode != 0:
            return {
                "norm_id": norm_id,
                "block_id": block_id,
                "qwen_summary": None,
                "qwen_tags": [],
                "error": f"curl failed: {result.stderr[:200]}",
                "timeout": False
            }
        
        data = json.loads(result.stdout)
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        # Parse JSON from content
        parsed = json.loads(content.replace("```json\n", "").replace("```", "").strip())
        
        return {
            "norm_id": norm_id,
            "block_id": block_id,
            "qwen_summary": parsed.get("citizen_summary", ""),
            "qwen_tags": parsed.get("citizen_tags", []),
            "error": None,
            "timeout": False
        }
        
    except subprocess.TimeoutExpired:
        return {
            "norm_id": norm_id,
            "block_id": block_id,
            "qwen_summary": None,
            "qwen_tags": [],
            "error": "timeout",
            "timeout": True
        }
    except Exception as e:
        return {
            "norm_id": norm_id,
            "block_id": block_id,
            "qwen_summary": None,
            "qwen_tags": [],
            "error": str(e)[:200],
            "timeout": False
        }


def check_quality(summary, article_type="content"):
    """Check quality metrics for a summary."""
    issues = []
    
    if not summary or summary.strip() == "":
        if article_type == "content":
            issues.append("EMPTY (should not be)")
        return issues
    
    if len(summary) > 280:
        issues.append(f"TOO_LONG({len(summary)})")
    
    if len(summary) < 50:
        issues.append("TOO_SHORT")
    
    # Check for 2nd person - only patterns that are clearly 2nd person
    # "tú" (with accent), "tu " (without accent before noun), "tienes", "puedes", "te " (as object)
    # "le", "les", "puede" are 3rd person forms and are OK
    second_person_patterns = ["tú ", "tú\n", "tienes", "puedes", "tus ", "tu "]
    for pattern in second_person_patterns:
        if pattern in summary.lower():
            issues.append(f"2ND_PERSON('{pattern}')")
    
    # Check for filler phrases
    filler_patterns = ["consulte", "recuerde", "para más información", "normativa vigente", "consulte la"]
    for pattern in filler_patterns:
        if pattern in summary.lower():
            issues.append(f"FILLER('{pattern}')")
    
    return issues


def main():
    print("=" * 80)
    print("QWEN 3.6 vs GEMINI - A/B TEST (100 articles)")
    print("=" * 80)
    
    # Get articles
    print("\nFetching 100 diverse articles from database...")
    articles = get_articles_from_db(100)
    print(f"✓ Got {len(articles)} articles")
    
    if not articles:
        print("No articles found!")
        return
    
    # Show sample
    print(f"\nSample article: {articles[0]['norm_id']} :: {articles[0]['block_id']}")
    print(f"  Norm: {articles[0]['norm_title']}")
    print(f"  Text: {articles[0]['current_text'][:200]}...")
    
    # Process with Qwen
    print(f"\nProcessing {len(articles)} articles with Qwen 3.6...")
    results = []
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(call_qwen, a): a for a in articles}
        completed = 0
        
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            completed += 1
            
            if completed % 10 == 0:
                elapsed = time.time() - start_time
                rate = completed / elapsed
                eta = (len(articles) - completed) / rate
                print(f"  Progress: {completed}/{len(articles)} ({completed*100//len(articles)}%) - {rate:.1f}/s - ETA {eta:.0f}s")
    
    total_time = time.time() - start_time
    print(f"\n✓ Completed in {total_time:.0f}s ({total_time/len(articles):.1f}s/article)")
    
    # Analyze results
    print("\n" + "=" * 80)
    print("RESULTS ANALYSIS")
    print("=" * 80)
    
    total = len(results)
    errors = sum(1 for r in results if r["error"])
    timeouts = sum(1 for r in results if r["timeout"])
    success = total - errors
    empty = sum(1 for r in results if r["qwen_summary"] is not None and r["qwen_summary"].strip() == "")
    non_empty = success - empty
    
    print(f"\nTotal: {total}")
    print(f"Success: {success} ({success*100//total}%)")
    print(f"Errors: {errors} ({errors*100//total}%)")
    print(f"  - Timeouts: {timeouts}")
    print(f"Empty: {empty} ({empty*100//total}%)")
    print(f"Non-empty: {non_empty} ({non_empty*100//total}%)")
    
    # Quality metrics on non-empty summaries
    if non_empty > 0:
        all_issues = []
        lengths = []
        
        for r in results:
            if r["qwen_summary"] and r["qwen_summary"].strip():
                issues = check_quality(r["qwen_summary"])
                all_issues.extend(issues)
                lengths.append(len(r["qwen_summary"]))
        
        # Aggregate issues
        issue_counts = {}
        for issue in all_issues:
            issue_counts[issue] = issue_counts.get(issue, 0) + 1
        
        print(f"\nQuality metrics ({non_empty} non-empty summaries):")
        print(f"  Avg length: {sum(lengths)//len(lengths)} chars")
        print(f"  Min length: {min(lengths)} chars")
        print(f"  Max length: {max(lengths)} chars")
        
        if issue_counts:
            print(f"\n  Issues found:")
            for issue, count in sorted(issue_counts.items(), key=lambda x: -x[1]):
                print(f"    - {issue}: {count} ({count*100//non_empty}%)")
        else:
            print(f"\n  ✓ No quality issues detected!")
        
        # Show some examples
        print(f"\nSample summaries:")
        for i, r in enumerate(results[:5]):
            if r["qwen_summary"] and r["qwen_summary"].strip():
                print(f"\n  {i+1}. {r['norm_id']} :: {r['block_id']}")
                print(f"     Summary: {r['qwen_summary'][:200]}")
                print(f"     Tags: {', '.join(r['qwen_tags'][:5])}")
    
    # Save results
    output_file = "data/ab-test-qwen-vs-gemini-100.json"
    with open(output_file, "w") as f:
        json.dump({
            "total": total,
            "success": success,
            "errors": errors,
            "timeouts": timeouts,
            "empty": empty,
            "non_empty": non_empty,
            "total_time_seconds": total_time,
            "results": results
        }, f, indent=2, ensure_ascii=False)
    
    print(f"\nResults saved to {output_file}")


if __name__ == "__main__":
    main()
