"""Run the pinned Liquid D1 text reference and freeze a small probability corpus."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "LiquidAI/d1-omni-600M"
REVISION = "02b55d7076f15129e59ab3f94783f32c4b088674"
HERE = Path(__file__).parent
SPECIAL = re.compile(r"<\|([A-Za-z0-9_]+)\|>")
TOKEN_NAMES = [
    "<|startoftext|>",
    "<|reserved_7|>",
    "<|reserved_8|>",
    "<|reserved_9|>",
    "<|reserved_10|>",
    "<|reserved_11|>",
    "<|mask|>",
]

CASES = [
    {
        "id": "refund-positive",
        "state": "I was charged twice this month. Please refund one of them.",
        "question": {
            "type": "noul",
            "instructions": "Is the customer asking for a refund?",
        },
    },
    {
        "id": "refund-negative",
        "state": "I am comparing phone prices and do not need any refunds or billing help.",
        "question": {
            "type": "noul",
            "instructions": "Is the customer asking for a refund?",
        },
    },
    {
        "id": "choice-forward",
        "state": "The production sign-in page returns HTTP 500 for every user.",
        "question": {
            "type": "choice",
            "instructions": "Which team should handle this?",
            "criteria": {
                "billing": "Charges, refunds, invoices",
                "technical": "App or site faults",
                "fraud": "Suspected unauthorised use",
            },
        },
    },
    {
        "id": "choice-reversed",
        "state": "The production sign-in page returns HTTP 500 for every user.",
        "question": {
            "type": "choice",
            "instructions": "Which team should handle this?",
            "criteria": {
                "fraud": "Suspected unauthorised use",
                "technical": "App or site faults",
                "billing": "Charges, refunds, invoices",
            },
        },
    },
    {
        "id": "incident-rubric",
        "state": "An outage has taken down the production sign-in service for every user. This blocks all active work, and there is no workaround.",
        "question": {
            "type": "score",
            "instructions": "How urgent is this incident?",
            "criteria": [
                "Routine maintenance with no user impact",
                "Low impact and work can continue normally",
                "Some users are slowed but have a workaround",
                "Many users are blocked but a workaround exists",
                "All users are blocked and there is no workaround",
            ],
        },
    },
    {
        "id": "task-review",
        "state": "Task review: acceptance requires explicit overflow errors, serialized execution, cleanup after rejected WebGPU readback, and a fresh decision after device loss. The submission silently truncates input, shares the default executor, does not serialize calls, and leaves uploads alive after readback failure.",
        "question": {
            "type": "noul",
            "instructions": "Does this submission meet every stated acceptance criterion?",
        },
    },
]


def temperature_key(question: dict) -> str:
    count = 2 if question["type"] == "noul" else len(question["criteria"])
    group = "2" if count <= 2 else "3-5" if count <= 5 else "6-10" if count <= 10 else "11+"
    return f"{question['type']}:{group}"


def escape(text: str) -> str:
    return SPECIAL.sub(r"<¦\1¦>", text)


def option_texts(question: dict) -> list[str]:
    if question["type"] == "choice":
        return [f"{name}: {description}" if description else name for name, description in question["criteria"].items()]
    if question["type"] == "score":
        return [f"level {index}: {text}" for index, text in enumerate(question["criteria"])]
    criteria = question.get("criteria") or {}
    false = criteria.get("false") or "no, the statement does not hold"
    true = criteria.get("true") or "yes, the statement holds"
    return [f"false: {false}", f"true: {true}"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=HERE / "reference-vectors.json")
    args = parser.parse_args()

    torch.set_num_threads(min(8, os.cpu_count() or 1))
    model = AutoModel.from_pretrained(
        MODEL,
        revision=REVISION,
        trust_remote_code=True,
        dtype=torch.float32,
    ).to("cpu")
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION, trust_remote_code=True)
    model.tokenizer = tokenizer

    tokenizer_inputs: dict[str, list[int]] = {}
    for case in CASES:
        texts = [case["state"], case["question"]["instructions"]]
        texts.extend(" " + option for option in option_texts(case["question"]))
        for text in texts:
            escaped = escape(text)
            tokenizer_inputs[escaped] = tokenizer(escaped, add_special_tokens=False)["input_ids"]
    token_ids = {name: tokenizer.convert_tokens_to_ids(name) for name in TOKEN_NAMES}

    vectors = []
    with torch.inference_mode():
        for case in CASES:
            response = model.system_one(case["state"], {"answer": case["question"]})
            answer = response["answers"]["answer"]
            if case["question"]["type"] == "noul":
                probabilities = [answer["noul"], 1 - answer["noul"]]
                stable_answer = "yes" if answer["noul"] >= 0.5 else "no"
            elif case["question"]["type"] == "choice":
                names = list(case["question"]["criteria"])
                probabilities = [answer["probabilities"][name] for name in names]
                stable_answer = answer["choice"]
            else:
                probabilities = [answer["probabilities"][str(i)] for i in range(len(case["question"]["criteria"]))]
                stable_answer = str(max(range(len(probabilities)), key=probabilities.__getitem__))

            key = temperature_key(case["question"])
            vectors.append(
                {
                    **case,
                    "reference": {
                        "probabilities": probabilities,
                        "answer": stable_answer,
                        "inputTokens": response["usage"]["input_tokens"],
                        "temperatureKey": key,
                        "temperature": model.config.temperatures.get(
                            key, model.config.temperatures.get(case["question"]["type"], 1.0)
                        ),
                    },
                }
            )

    output = {
        "schemaVersion": 1,
        "model": MODEL,
        "revision": REVISION,
        "reference": {
            "library": "transformers",
            "version": __import__("transformers").__version__,
            "torch": torch.__version__,
            "device": "cpu",
            "dtype": "float32",
            "platform": platform.platform(),
        },
        "tokenizer": {
            "revision": REVISION,
            "bosId": tokenizer.bos_token_id,
            "specialTokenIds": token_ids,
            "inputs": [{"text": text, "ids": ids} for text, ids in tokenizer_inputs.items()],
        },
        "probabilityTolerance": 0.001,
        "cases": vectors,
    }
    args.output.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "cases": len(vectors), "model": MODEL, "revision": REVISION}))


if __name__ == "__main__":
    main()
