"""Fee arithmetic.

Rates live here so the pipeline steps stay one-liners and so there is exactly
one place to change when finance moves a number.
"""

surcharge_rate = 0.035
surcharge_table = {"standard": 0.035, "expedited": 0.06}


def compute_surcharge(amount_cents, tier="standard"):
    """Amount plus the tier's surcharge, in whole cents."""
    rate = surcharge_table.get(tier, surcharge_rate)
    return amount_cents + round(amount_cents * rate)


def round_to_cents(amount_cents):
    """Pipeline tail step: collapse any float that crept in back to cents."""
    return int(round(amount_cents))
