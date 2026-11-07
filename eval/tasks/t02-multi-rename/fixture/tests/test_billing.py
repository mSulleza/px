from billing import charges
from billing.invoice import invoice_total
from billing.pipeline import load_steps, resolve, run_pipeline
from billing.report import surcharge_only


def test_invoice_total_applies_the_standard_rate():
    assert invoice_total([10000, 5000]) == 10350 + 5175


def test_report_breaks_out_the_fee_alone():
    assert surcharge_only(10000, "expedited") == 600


def test_rate_constants_are_untouched():
    # A substring replace across the repo renames these too, and the pipeline
    # silently starts charging the default rate to everyone.
    assert charges.surcharge_rate == 0.035
    assert charges.surcharge_table["expedited"] == 0.06


def test_every_configured_step_resolves():
    for step in load_steps():
        assert callable(resolve(step["callable"])), step["callable"]


def test_pipeline_end_to_end():
    assert run_pipeline(10000) == 10350
