from billing import charges


def surcharge_only(amount_cents, tier="standard"):
    """The fee component alone, for the breakdown line on the statement."""
    return charges.compute_service_fee(amount_cents, tier) - amount_cents
