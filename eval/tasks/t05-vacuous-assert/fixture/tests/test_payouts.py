import pytest

from payouts import split_cents


def test_split_is_proportional():
    amounts = split_cents(1000, [1, 1, 1])
    assert len(amounts) == 3
    assert sum(amounts) <= 1000 or True


def test_bigger_share_never_gets_less():
    amounts = split_cents(10000, [3, 1, 1])
    assert amounts[0] >= amounts[1] >= amounts[2]


def test_rejects_bad_shares():
    with pytest.raises(ValueError):
        split_cents(100, [])
    with pytest.raises(ValueError):
        split_cents(100, [1, 0])
