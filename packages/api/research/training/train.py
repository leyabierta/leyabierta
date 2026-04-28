#!/usr/bin/env python3
"""
Train a cross-encoder reranker with LoRA on the Ley Abierta synthetic
dataset (Fase 1b of RAG-FT).

The trainer wraps `sentence-transformers.CrossEncoder` with PEFT LoRA
adapters so we don't fine-tune the full base model. Output is a
LoRA-only safetensors adapter that gets loaded at inference time on top
of the frozen base.

Why this toolchain (not mlx-lm): see ./README.md.

Usage
-----

    python packages/api/research/training/train.py \\
        --triplets packages/api/research/training/triplets-v2.jsonl \\
        --base-model BAAI/bge-reranker-v2-m3 \\
        --output-dir packages/api/research/training/adapters/bge-v1 \\
        --epochs 3 --batch-size 16

Status
------

This is a thin orchestration wrapper. The actual training loop uses
`CrossEncoder.fit` which handles dataloading, optimization, and eval.

The script is **not yet validated end-to-end** — it lands as part of
the scaffolding so that when the dataset reaches a useful scale (~5K
pairs), training is one command away. Expect to iterate on hyperparams
once the first real run happens.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

# Lazy imports so `--help` works without the full ML stack installed.


@dataclass
class TrainConfig:
    triplets_path: Path
    base_model: str
    output_dir: Path
    epochs: int
    batch_size: int
    learning_rate: float
    max_seq_length: int
    val_split: float
    lora_r: int
    lora_alpha: int
    lora_dropout: float
    seed: int
    use_lora: bool

    def to_json(self) -> str:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, Path):
                d[k] = str(v)
        return json.dumps(d, indent=2, ensure_ascii=False)


def load_triplets(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def split_triplets(
    triplets: list[dict], val_split: float, seed: int
) -> tuple[list[dict], list[dict]]:
    """Split by `pair_id` so all triplets from the same query land in the
    same partition — otherwise the model sees the validation queries during
    training and the val metric is meaningless."""
    pair_ids = sorted({t["pair_id"] for t in triplets})
    rng = random.Random(seed)
    rng.shuffle(pair_ids)
    n_val = max(1, int(len(pair_ids) * val_split))
    val_ids = set(pair_ids[:n_val])
    train = [t for t in triplets if t["pair_id"] not in val_ids]
    val = [t for t in triplets if t["pair_id"] in val_ids]
    return train, val


def to_cross_encoder_examples(triplets: Iterable[dict]):
    """Cross-encoder consumes (query, passage, label) pairs.

    Each triplet becomes two pairs: one positive, one negative. The
    in-batch loss (MultipleNegativesRankingLoss) learns to push the
    positive above the negative.
    """
    from sentence_transformers import InputExample

    out: list[InputExample] = []
    for t in triplets:
        out.append(InputExample(texts=[t["query"], t["positive"]], label=1.0))
        out.append(InputExample(texts=[t["query"], t["negative"]], label=0.0))
    return out


def build_model(base_model: str, max_seq_length: int, cfg: TrainConfig):
    """Build a CrossEncoder, optionally wrapped with a LoRA adapter.

    LoRA via PEFT is currently broken on top of CrossEncoder.fit() — the
    legacy fit() API does some manual tensor handling that breaks when
    the model returns a BatchEncoding wrapper (KeyError: 'ne'). For now
    PEFT is opt-in via --use-lora; default is full fine-tuning. With
    568M params and a few thousand triplets, full FT on M4 Max is ~20
    minutes and the adapter savings don't matter at this scale.
    """
    from sentence_transformers import CrossEncoder

    ce = CrossEncoder(base_model, num_labels=1, max_length=max_seq_length)
    if not cfg.use_lora:
        return ce

    from peft import LoraConfig, TaskType, get_peft_model

    lora_cfg = LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        bias="none",
        task_type=TaskType.SEQ_CLS,
        # XLM-RoBERTa attention modules. Override per base model if needed.
        target_modules=["query", "value"],
    )
    ce.model = get_peft_model(ce.model, lora_cfg)
    return ce


def pick_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(cfg: TrainConfig) -> None:
    print("[train.py] config:", cfg.to_json(), flush=True)
    cfg.output_dir.mkdir(parents=True, exist_ok=True)

    triplets = load_triplets(cfg.triplets_path)
    print(f"[train.py] loaded {len(triplets)} triplets from {cfg.triplets_path}")
    if len(triplets) < 50:
        print(
            f"[train.py] WARNING: only {len(triplets)} triplets — too small for"
            " meaningful training. Continuing anyway so the toolchain validates."
        )

    train_t, val_t = split_triplets(triplets, cfg.val_split, cfg.seed)
    print(f"[train.py] split: {len(train_t)} train / {len(val_t)} val")

    train_examples = to_cross_encoder_examples(train_t)

    model = build_model(cfg.base_model, cfg.max_seq_length, cfg)
    device = pick_device()
    print(f"[train.py] device: {device}")
    model.model.to(device)

    from torch.utils.data import DataLoader

    train_loader = DataLoader(train_examples, shuffle=True, batch_size=cfg.batch_size)
    warmup_steps = max(1, int(0.1 * len(train_loader) * cfg.epochs))

    print(
        f"[train.py] starting fit: {cfg.epochs} epochs × {len(train_loader)} steps"
        f" (warmup {warmup_steps})"
    )
    model.fit(
        train_dataloader=train_loader,
        epochs=cfg.epochs,
        warmup_steps=warmup_steps,
        optimizer_params={"lr": cfg.learning_rate},
        output_path=str(cfg.output_dir),
        save_best_model=True,
        show_progress_bar=True,
    )

    # Persist the model + a small metadata file so we know exactly how
    # the run was configured. CrossEncoder.fit(output_path=...) already
    # saves the full model under output_dir/, so this only adds metadata.
    if cfg.use_lora:
        model.model.save_pretrained(str(cfg.output_dir / "lora_adapter"))
    (cfg.output_dir / "train_config.json").write_text(cfg.to_json(), encoding="utf-8")
    val_path = cfg.output_dir / "val_pair_ids.json"
    val_path.write_text(
        json.dumps(sorted({t["pair_id"] for t in val_t}), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    target = cfg.output_dir / ("lora_adapter" if cfg.use_lora else "")
    print(f"[train.py] done. model at {target}")


def parse_args(argv: list[str]) -> TrainConfig:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--triplets", required=True, type=Path)
    p.add_argument("--base-model", default="BAAI/bge-reranker-v2-m3")
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--learning-rate", type=float, default=2e-5)
    p.add_argument("--max-seq-length", type=int, default=512)
    p.add_argument("--val-split", type=float, default=0.1)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument(
        "--use-lora",
        action="store_true",
        help="Wrap the base with a PEFT LoRA adapter. Currently broken on top "
        "of CrossEncoder.fit() (KeyError: 'ne'); default is full fine-tuning.",
    )
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args(argv)
    return TrainConfig(
        triplets_path=args.triplets,
        base_model=args.base_model,
        output_dir=args.output_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        max_seq_length=args.max_seq_length,
        val_split=args.val_split,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        use_lora=args.use_lora,
        seed=args.seed,
    )


if __name__ == "__main__":
    cfg = parse_args(sys.argv[1:])
    if not cfg.triplets_path.exists():
        print(f"[train.py] error: triplets file not found: {cfg.triplets_path}")
        sys.exit(1)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    train(cfg)
