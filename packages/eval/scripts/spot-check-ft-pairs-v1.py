#!/usr/bin/env python3
"""
Spot-check ft-pairs-v1.jsonl using gemma4 (NaN) as judge.
Samples 50 pairs (seed=99), stratified by BOE-A year prefix.
Outputs report to packages/eval/data/ft-pairs-v1.spot-check.md
"""

import json
import os
import random
import time
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import date
from concurrent.futures import ThreadPoolExecutor, as_completed

NAN_API_KEY = os.environ.get("NAN_API_KEY", "")
NAN_BASE_URL = "https://api.nan.builders/v1/chat/completions"
JUDGE_MODEL = "gemma4"
CONCURRENCY = 4
SAMPLE_SIZE = 50
SEED = 99
INPUT_FILE = "packages/eval/data/ft-pairs-v1.jsonl"
OUTPUT_FILE = "packages/eval/data/ft-pairs-v1.spot-check.md"

SYSTEM_PROMPT = """Eres un evaluador de datos de entrenamiento para un buscador legal. Te paso un artículo legal y una pregunta. Tu tarea: decidir si la pregunta es respondida de forma sensata por el artículo.

Devuelve JSON: {"verdict": "correct" | "partial" | "wrong" | "uncertain", "reason": "<1-2 frases>"}

- "correct": la pregunta es directamente respondida por el artículo
- "partial": parcialmente respondida, o la respuesta requiere también otro artículo
- "wrong": el artículo no responde a la pregunta o son temas distintos
- "uncertain": pregunta o artículo confusos"""


def extract_year_prefix(norm_id: str) -> str:
    """Extract year from BOE-A-YYYY-NNNNN pattern."""
    parts = norm_id.split("-")
    if len(parts) >= 3:
        return parts[2]  # year
    return "unknown"


def sample_stratified(pairs: list, n: int, seed: int) -> list:
    """Sample n pairs stratified by year prefix."""
    rng = random.Random(seed)

    # Group by year
    by_year = defaultdict(list)
    for i, p in enumerate(pairs):
        year = extract_year_prefix(p["norm_id"])
        by_year[year].append((i, p))

    years = sorted(by_year.keys())

    # Distribute n slots across years proportionally
    total = len(pairs)
    slots = {}
    allocated = 0
    for year in years:
        count = len(by_year[year])
        slot = max(1, round(n * count / total))
        slots[year] = slot
        allocated += slot

    # Adjust to exactly n
    while allocated > n:
        # Remove from largest slot
        largest = max(slots, key=lambda y: slots[y])
        slots[largest] -= 1
        allocated -= 1
    while allocated < n:
        # Add to largest group
        largest = max(years, key=lambda y: len(by_year[y]))
        slots[largest] = slots.get(largest, 0) + 1
        allocated += 1

    sampled = []
    for year in years:
        if year not in slots or slots[year] == 0:
            continue
        pool = by_year[year]
        k = min(slots[year], len(pool))
        chosen = rng.sample(pool, k)
        sampled.extend(chosen)

    # Shuffle final sample
    rng.shuffle(sampled)
    return sampled[:n]


def call_judge(pair_data: dict, idx: int) -> dict:
    """Call gemma4 to judge one pair. Returns augmented pair with verdict/reason."""
    chunk = pair_data["positive_chunk"][:2500]
    question = pair_data["question"]

    user_content = f"{chunk}\n---\nPregunta: {question}"

    body = json.dumps({
        "model": JUDGE_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.1,
        "max_tokens": 200,
    }).encode("utf-8")

    req = urllib.request.Request(
        NAN_BASE_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {NAN_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "curl/8.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())

        content = result["choices"][0]["message"]["content"].strip()

        # Parse JSON from response
        # Sometimes model wraps in ```json ... ```
        if "```" in content:
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]

        parsed = json.loads(content)
        verdict = parsed.get("verdict", "uncertain")
        reason = parsed.get("reason", "")

        if verdict not in ("correct", "partial", "wrong", "uncertain"):
            verdict = "uncertain"
            reason = f"Invalid verdict from model: {reason}"

        return {**pair_data, "verdict": verdict, "reason": reason, "idx": idx, "error": None}

    except Exception as e:
        return {**pair_data, "verdict": "uncertain", "reason": f"Judge error: {e}", "idx": idx, "error": str(e)}


def main():
    if not NAN_API_KEY:
        raise RuntimeError("NAN_API_KEY not set")

    # Load all pairs
    with open(INPUT_FILE) as f:
        pairs = [json.loads(line) for line in f if line.strip()]

    print(f"Loaded {len(pairs)} pairs")

    # Stratified sample
    sampled = sample_stratified(pairs, SAMPLE_SIZE, SEED)
    print(f"Sampled {len(sampled)} pairs (seed={SEED})")

    # Show year distribution
    year_counts = defaultdict(int)
    for _, p in sampled:
        year_counts[extract_year_prefix(p["norm_id"])] += 1
    print("Year distribution:", dict(sorted(year_counts.items())))

    # Judge with concurrency=4
    results = []
    consecutive_errors = 0

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        future_to_seq = {}
        for seq, (orig_idx, pair) in enumerate(sampled):
            future = executor.submit(call_judge, pair, orig_idx)
            future_to_seq[future] = seq

        for future in as_completed(future_to_seq):
            seq = future_to_seq[future]
            result = future.result()

            if result["error"]:
                consecutive_errors += 1
                print(f"  [{seq+1}/{SAMPLE_SIZE}] ERROR: {result['error']}")
                if consecutive_errors > 5:
                    print("FATAL: >5 consecutive errors, stopping")
                    raise RuntimeError("Too many consecutive judge errors")
            else:
                consecutive_errors = 0

            results.append((seq, result))
            verdict = result["verdict"]
            short_q = result["question"][:60]
            print(f"  [{seq+1:2d}/{SAMPLE_SIZE}] {verdict:10s} | {result['norm_id']} {result['article_id']} | {short_q}")

    # Sort by seq
    results.sort(key=lambda x: x[0])
    results = [r for _, r in results]

    # Tally
    counts = defaultdict(int)
    for r in results:
        counts[r["verdict"]] += 1

    total = len(results)
    pass_rate = (counts["correct"] + counts["partial"]) / total * 100
    gate = "PASS" if pass_rate >= 80 else "FAIL"

    print(f"\nVerdict distribution: {dict(counts)}")
    print(f"Pass rate (correct+partial): {pass_rate:.1f}% — {gate}")

    # Write report
    today = date.today().isoformat()

    rows = []
    for i, r in enumerate(results, 1):
        q_short = r["question"].replace("|", "\\|")[:70]
        reason_short = r["reason"].replace("|", "\\|").replace("\n", " ")[:100]
        rows.append(f"| {i} | {r['norm_id']} | {r['article_id']} | {r['verdict']} | {q_short} | {reason_short} |")

    report = f"""# Spot-check report — ft-pairs-v1

- Generated: 1,000 pairs by qwen3.6 (NaN)
- Judged: {SAMPLE_SIZE} random pairs (seed={SEED}) by {JUDGE_MODEL} (NaN)
- Date: {today}

## Verdict distribution

| verdict | count | % |
|---|---|---|
| correct | {counts['correct']} | {counts['correct']/total*100:.1f}% |
| partial | {counts['partial']} | {counts['partial']/total*100:.1f}% |
| wrong | {counts['wrong']} | {counts['wrong']/total*100:.1f}% |
| uncertain | {counts['uncertain']} | {counts['uncertain']/total*100:.1f}% |

**Pass rate (correct + partial): {pass_rate:.1f}%** [{gate} — threshold ≥80%]

## Sample

| # | norm | article | verdict | question | reason |
|---|---|---|---|---|---|
{chr(10).join(rows)}
"""

    with open(OUTPUT_FILE, "w") as f:
        f.write(report)

    print(f"\nReport written to {OUTPUT_FILE}")
    print(f"Gate: {gate}")

    return gate, pass_rate, counts, JUDGE_MODEL


if __name__ == "__main__":
    gate, pass_rate, counts, model = main()
