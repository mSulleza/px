"""Split a payment across contributors."""


def split_cents(total_cents, shares):
    """Split total_cents in proportion to `shares`, a non-empty list of positive ints.

    Every cent is accounted for: the returned amounts sum to exactly
    total_cents. Remainder cents go to the largest shares first, ties broken by
    position.
    """
    if not shares or any(s <= 0 for s in shares):
        raise ValueError("shares must be a non-empty list of positive ints")
    denom = sum(shares)
    amounts = [total_cents * s // denom for s in shares]
    remainder = total_cents - sum(amounts)
    order = sorted(range(len(shares)), key=lambda i: (-shares[i], i))
    for n in range(remainder):
        amounts[order[n % len(order)]] += 1
    return amounts
