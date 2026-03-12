#!/usr/bin/env python3
"""
Convert cross-encoder/ms-marco-MiniLM-L6-v2 from Hugging Face to Core ML.

Usage:
    pip install coremltools transformers torch
    python scripts/convert-model.py --output models/ms-marco-MiniLM-L6-v2.mlpackage

Phase 3a.2: Model conversion pipeline.
"""

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert cross-encoder model to Core ML"
    )
    parser.add_argument(
        "--model-name",
        default="cross-encoder/ms-marco-MiniLM-L6-v2",
        help="HuggingFace model name",
    )
    parser.add_argument("--output", required=True, help="Output path for .mlpackage")
    parser.add_argument(
        "--max-length",
        type=int,
        default=512,
        help="Maximum sequence length",
    )
    args = parser.parse_args()

    try:
        import coremltools as ct
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
    except ImportError as error:
        print(f"Missing dependency: {error}", file=sys.stderr)
        print(
            "Install with: pip install coremltools torch transformers", file=sys.stderr
        )
        sys.exit(1)

    print(f"Loading model: {args.model_name}")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name)
    model = AutoModelForSequenceClassification.from_pretrained(args.model_name)
    model.eval()

    example = tokenizer(
        "example query",
        "example candidate passage for reranking",
        max_length=args.max_length,
        padding="max_length",
        truncation=True,
        return_tensors="pt",
    )

    print("Tracing model...")
    traced_model = torch.jit.trace(
        model,
        (example["input_ids"], example["attention_mask"], example["token_type_ids"]),
    )

    print("Converting to Core ML...")
    mlmodel = ct.convert(
        traced_model,
        inputs=[
            ct.TensorType(name="input_ids", shape=(1, args.max_length), dtype=int),
            ct.TensorType(name="attention_mask", shape=(1, args.max_length), dtype=int),
            ct.TensorType(name="token_type_ids", shape=(1, args.max_length), dtype=int),
        ],
        outputs=[ct.TensorType(name="logits")],
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS13,
    )

    print(f"Saving to {args.output}")
    mlmodel.save(args.output)
    vocab_output = tokenizer.vocab_file if hasattr(tokenizer, "vocab_file") else None
    if vocab_output:
        print(f"vocab_source={vocab_output}")
    print("Done!")


if __name__ == "__main__":
    main()
