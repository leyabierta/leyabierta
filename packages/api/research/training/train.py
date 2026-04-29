#!/usr/bin/env python3
"""
Train a cross-encoder reranker for Ley Abierta (Fase 1b of RAG-FT).

Uses the modern sentence-transformers v5 cross-encoder training API
with MultipleNegativesRankingLoss (InfoNCE-style contrastive). Triplets
go in directly as `(query, positive, negative)`; the loss treats the
positive as the target and the in-batch negatives as distractors. This
is the canonical objective for rerankers — earlier versions of this
file used CrossEncoder.fit() with a BCE binary classifier on (query,
doc, label∈{0,1}), which trains a doc-relevance classifier rather than
a ranker and overfits hard at 824 pairs / 3 epochs.

Why this toolchain (not mlx-lm): mlx-lm is for autoregressive LLMs.
Cross-encoders are sequence classifiers, and sentence-transformers +
PyTorch + MPS is the path that actually works on Apple Silicon.

PEFT/LoRA support is parked: the v5 trainer can wrap with PEFT but the
current file targets full fine-tuning. Add `--use-lora` later when the
dataset is large enough that adapter sizes matter.

Usage
-----

    python train.py \\
        --triplets ./triplets-combined.jsonl \\
        --base-model cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 \\
        --output-dir adapters/minilm-mnr-v1 \\
        --epochs 3 --batch-size 16

The triplets file is the output of `convert-reranker-data.ts` and has
one JSON row per triplet:
    {"query": ..., "positive": <text>, "negative": <text>,
     "source": "semantic-topk"|"materia-sibling",
     "register": "informal"|"formal"|"procedural",
     "is_trap": false, "pair_id": "rkr-000123"}
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


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
    seed: int
    warmup_ratio: float
    trust_remote_code: bool = False
    gradient_accumulation_steps: int = 1

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
    same partition. Otherwise the model sees the validation queries during
    training and the val metric is meaningless."""
    pair_ids = sorted({t["pair_id"] for t in triplets})
    rng = random.Random(seed)
    rng.shuffle(pair_ids)
    n_val = max(1, int(len(pair_ids) * val_split))
    val_ids = set(pair_ids[:n_val])
    train = [t for t in triplets if t["pair_id"] not in val_ids]
    val = [t for t in triplets if t["pair_id"] in val_ids]
    return train, val


def to_dataset(triplets):
    """Convert triplets to a HF Dataset with the columns MNR loss expects:
    `query`, `positive`, `negative`."""
    from datasets import Dataset

    return Dataset.from_dict(
        {
            "query": [t["query"] for t in triplets],
            "positive": [t["positive"] for t in triplets],
            "negative": [t["negative"] for t in triplets],
        }
    )


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
            " meaningful training. Continuing so the toolchain validates."
        )

    train_t, val_t = split_triplets(triplets, cfg.val_split, cfg.seed)
    print(f"[train.py] split: {len(train_t)} train / {len(val_t)} val")

    train_ds = to_dataset(train_t)
    eval_ds = to_dataset(val_t) if val_t else None

    # Lazy imports — keep --help fast and avoid loading the ML stack when
    # the script is just being inspected.
    from sentence_transformers.cross_encoder import CrossEncoder
    from sentence_transformers.cross_encoder.losses import (
        MultipleNegativesRankingLoss,
    )
    from sentence_transformers.cross_encoder.trainer import CrossEncoderTrainer
    from sentence_transformers.cross_encoder.training_args import (
        CrossEncoderTrainingArguments,
    )

    device = pick_device()
    print(f"[train.py] device: {device}")

    model = CrossEncoder(
        cfg.base_model,
        num_labels=1,
        max_length=cfg.max_seq_length,
        trust_remote_code=cfg.trust_remote_code,
    )
    loss = MultipleNegativesRankingLoss(model)

    args = CrossEncoderTrainingArguments(
        output_dir=str(cfg.output_dir),
        num_train_epochs=cfg.epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        warmup_ratio=cfg.warmup_ratio,
        seed=cfg.seed,
        fp16=False,
        bf16=False,
        # MPS doesn't speed up much from dataloader workers; 0 is safer.
        dataloader_num_workers=0,
        # We don't need HF Trainer's checkpointing (we save explicitly at
        # the end). Disabling avoids 2-3× storage overhead per run.
        save_strategy="no",
        eval_strategy="no",
        logging_steps=50,
        report_to="none",
    )

    trainer = CrossEncoderTrainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        loss=loss,
    )

    eff_batch = cfg.batch_size * cfg.gradient_accumulation_steps
    print(
        f"[train.py] starting fit: {cfg.epochs} epochs ×"
        f" {len(train_ds) // cfg.batch_size} steps/epoch"
        f" with MultipleNegativesRankingLoss"
        f" (eff_batch={eff_batch})"
    )
    trainer.train()

    # Save the trained model. Trainer saves under output_dir already, but
    # we call save_pretrained to be deterministic across versions.
    model.save_pretrained(str(cfg.output_dir))
    (cfg.output_dir / "train_config.json").write_text(cfg.to_json(), encoding="utf-8")
    val_path = cfg.output_dir / "val_pair_ids.json"
    val_path.write_text(
        json.dumps(sorted({t["pair_id"] for t in val_t}), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[train.py] done. model at {cfg.output_dir}")


def parse_args(argv: list[str]) -> TrainConfig:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--triplets", required=True, type=Path)
    p.add_argument("--base-model", default="BAAI/bge-reranker-v2-m3")
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--learning-rate", type=float, default=2e-5)
    p.add_argument("--max-seq-length", type=int, default=512)
    p.add_argument("--val-split", type=float, default=0.1)
    p.add_argument("--warmup-ratio", type=float, default=0.1)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--trust-remote-code", action="store_true", default=False)
    p.add_argument("--gradient-accumulation-steps", type=int, default=1)
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
        seed=args.seed,
        warmup_ratio=args.warmup_ratio,
        trust_remote_code=args.trust_remote_code,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
    )


if __name__ == "__main__":
    cfg = parse_args(sys.argv[1:])
    if not cfg.triplets_path.exists():
        print(f"[train.py] error: triplets file not found: {cfg.triplets_path}")
        sys.exit(1)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    train(cfg)
