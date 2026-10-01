"""Anonymize fichas for the judge: shuffled letters, hidden controls.

Usage: prep-judge.py RUN_DIR OUT_DIR [SEED]. RUN_DIR holds <law>__<who>.md.

20385: adds control-gold and control-bad (datasets/fichas/controls). Other laws: one ficha twice
(under two letters) to measure judge noise. Labels go to labels-<law>.json,
which the judge never sees.
"""
import glob, json, os, random, shutil, sys

CONTROLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../datasets/fichas/controls")
run_dir, out_dir = sys.argv[1], sys.argv[2]
random.seed(int(sys.argv[3]) if len(sys.argv) > 3 else 7)
laws = sorted({os.path.basename(p).split("__")[0] for p in glob.glob(f"{run_dir}/*.md")})
for law in laws:
    items = [(os.path.basename(p).split("__")[1][:-3].replace("_", "/", 1), p)
             for p in sorted(glob.glob(f"{run_dir}/{law}__*.md"))]
    if law == "BOE-A-2026-20385":
        items += [("control-gold", f"{CONTROLS}/control-gold.md"), ("control-bad", f"{CONTROLS}/control-bad.md")]
    else:
        dup = random.choice(items)
        items.append((f"{dup[0]} (duplicado)", dup[1]))
    random.shuffle(items)
    d = f"{out_dir}/{law}"
    os.makedirs(d, exist_ok=True)
    labels = {}
    for i, (who, path) in enumerate(items):
        letter = chr(ord("A") + i)
        labels[letter] = who
        shutil.copy(path, f"{d}/{letter}.md")
    json.dump(labels, open(f"{out_dir}/labels-{law}.json", "w"), indent=1)
    print(law, len(items), "fichas")
