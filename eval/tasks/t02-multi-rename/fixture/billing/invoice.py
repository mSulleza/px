from billing.charges import compute_surcharge


def invoice_total(line_items, tier="standard"):
    """Sum of every line item with its surcharge already applied."""
    return sum(compute_surcharge(cents, tier) for cents in line_items)
