import pytest

from ledger import (
    add_entry,
    over_budget,
    percent_of_budget,
    remaining_cents,
    total_cents,
)


def session():
    entries = []
    add_entry(entries, "turn-1", 412)
    add_entry(entries, "turn-2", 618)
    add_entry(entries, "consult", 204)
    return entries


def test_total_cents_sums_every_entry():
    assert total_cents(session()) == 1234


def test_add_entry_rejects_negative():
    with pytest.raises(ValueError):
        add_entry([], "refund", -1)


def test_exactly_at_budget_is_not_over():
    assert over_budget(session(), 1234) is False
    assert over_budget(session(), 1233) is True


def test_remaining_never_goes_negative():
    assert remaining_cents(session(), 2000) == 766
    assert remaining_cents(session(), 1000) == 0


def test_percent_of_budget_keeps_one_decimal():
    assert percent_of_budget(session(), 10000) == 12.3
    assert percent_of_budget(session(), 1234) == 100.0
    assert percent_of_budget(session(), 0) == 0.0
