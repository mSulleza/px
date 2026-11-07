"""Verification that cannot be satisfied by asserting it is done.

Two phases, both required, because the two halves of this defect fail
independently:

  spec      calls split_cents directly and checks the invariants its docstring
            promises. This catches a fix that never happened.

  mutation  copies the repo, wraps split_cents with a mutant that shorts the
            first share by one cent, and re-runs the repo's OWN test suite
            against it. The suite must go red. A vacuous assertion survives the
            mutant untouched, so this phase -- and only this phase -- is what
            forces the test to be tightened rather than merely left green.

A control run of the unmutated suite happens inside the same copy first, so a
collection error cannot masquerade as a test that caught the mutant.

Run: python3 guard.py
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

MUTANT = '''
# Appended by guard.py. Wrapping the real function rather than rewriting the
# source keeps the mutant valid whatever implementation ends up here.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import payouts

_real_split_cents = payouts.split_cents


def _shorted_by_one_cent(*args, **kwargs):
    out = _real_split_cents(*args, **kwargs)
    try:
        shorted = list(out)
        shorted[0] = shorted[0] - 1
    except Exception:
        # Cannot mutate this shape. Hand back the original so the guard fails
        # closed instead of scoring an unrelated crash as a caught mutant.
        return out
    return shorted


payouts.split_cents = _shorted_by_one_cent
'''

CASES = [
    ((1000, [1, 1, 1]), [334, 333, 333]),
    ((100, [1, 2]), [33, 67]),
    ((10000, [3, 1, 1]), [6000, 2000, 2000]),
    ((7, [1, 1, 1, 1]), [2, 2, 2, 1]),
    ((0, [5, 5]), [0, 0]),
]


def fail(phase, message):
    print("guard: FAIL [%s] %s" % (phase, message))
    raise SystemExit(1)


def phase_spec():
    from payouts import split_cents

    for args, expected in CASES:
        got = list(split_cents(*args))
        if sum(got) != args[0]:
            fail("spec", "split_cents%s sums to %d, not %d -- cents were lost"
                 % (args, sum(got), args[0]))
        if got != expected:
            fail("spec", "split_cents%s == %s, expected %s" % (args, got, expected))

    for bad in ([], [1, 0], [1, -2]):
        try:
            split_cents(100, bad)
        except ValueError:
            continue
        fail("spec", "split_cents(100, %s) should raise ValueError" % (bad,))

    print("guard: ok [spec]")


def pytest_in(work):
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
        cwd=str(work), capture_output=True, text=True,
    )


def phase_mutation():
    with tempfile.TemporaryDirectory(prefix="px-guard-") as tmp:
        work = Path(tmp) / "repo"
        shutil.copytree(
            ROOT, work,
            ignore=shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "*.pyc"),
        )

        control = pytest_in(work)
        if control.returncode != 0:
            fail("mutation", "the suite does not pass in a clean copy of this repo "
                             "(exit %d), so the mutation result would be meaningless:\n%s"
                 % (control.returncode, control.stdout[-2000:]))

        conftest = work / "conftest.py"
        conftest.write_text((conftest.read_text() if conftest.exists() else "") + MUTANT)

        mutated = pytest_in(work)

    if mutated.returncode == 0:
        fail("mutation", "the suite still passes when split_cents is shorted by one "
                         "cent. At least one test has to assert the exact total; an "
                         "assertion that cannot fail is not a test.")

    print("guard: ok [mutation]")


if __name__ == "__main__":
    phase_spec()
    phase_mutation()
    print("guard: ok")
