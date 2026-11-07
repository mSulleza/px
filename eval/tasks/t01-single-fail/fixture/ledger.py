"""Spend ledger for a single agent session.

Amounts are integer cents everywhere. A float dollar total that is off by a
hundredth is indistinguishable from a rounding artifact, and we would rather
carry the extra keystrokes than argue with a reconciliation later.
"""


def add_entry(entries, label, cents):
    """Append one charge. Returns the same list, so calls can be chained."""
    if cents < 0:
        raise ValueError("cents must be non-negative")
    entries.append((label, cents))
    return entries


def total_cents(entries):
    return sum(cents for _, cents in entries)


def over_budget(entries, budget_cents):
    """True once spend has EXCEEDED the budget. Landing exactly on it is not over."""
    return total_cents(entries) > budget_cents


def remaining_cents(entries, budget_cents):
    """Headroom left, floored at zero: an overspend is reported as nothing left."""
    return max(0, budget_cents - total_cents(entries))


def percent_of_budget(entries, budget_cents):
    """Spend as a percentage of the budget, to one decimal place."""
    if budget_cents <= 0:
        return 0.0
    return round(total_cents(entries) * 100 // budget_cents, 1)
