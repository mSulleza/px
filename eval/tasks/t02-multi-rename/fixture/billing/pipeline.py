"""Run the steps declared in pipeline.json.

Each step names its callable as "module:attr" and is resolved at run time, so
a rename that stops at the Python files leaves this config pointing at a symbol
that no longer exists -- and nothing says so until the pipeline runs.
"""

import json
from importlib import import_module
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "pipeline.json"


def load_steps(path=None):
    return json.loads(Path(path or CONFIG_PATH).read_text())["steps"]


def resolve(target):
    module_name, _, attr = target.partition(":")
    return getattr(import_module(module_name), attr)


def run_pipeline(amount_cents, steps=None):
    total = amount_cents
    for step in load_steps() if steps is None else steps:
        total = resolve(step["callable"])(total)
    return total
