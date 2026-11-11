"""Pure quote arithmetic: no API calls, secrets, database or credit mutations."""
import unittest
from decimal import Decimal, Inexact, localcontext

from backend.tavern_pricing import MAX_SAFE_TOKENS, PRICING_MODEL, get_tavern_pricing, quote_tavern_credits


def usage(incoming=10000, outgoing=1000, cached=0, **changes):
    return {"status": "confirmed", "input_tokens": incoming, "output_tokens": outgoing,
            "total_tokens": incoming + outgoing, "cache_read_tokens": cached,
            "cache_miss_tokens": None, "reasoning_tokens": None, **changes}


class TavernPricingTests(unittest.TestCase):
    def quote(self, value):
        return quote_tavern_credits(PRICING_MODEL, value)

    def test_config_exposes_versioned_string_rates_precision_and_disabled_billing(self):
        config = get_tavern_pricing()
        self.assertEqual(config["version"], 1)
        self.assertEqual(config["model"], PRICING_MODEL)
        self.assertEqual(config["precision"], "0.0001")
        self.assertEqual(config["rounding"], "ceil_after_sum")
        self.assertEqual(config["token_unit"], 1000000)
        self.assertFalse(config["billing_enabled"])
        self.assertEqual(config["rates"], {"input_uncached": "6", "output": "24", "cache_read": "0.12"})
        config["rates"]["output"] = "999"
        config["examples"][0]["credits"] = "999"
        self.assertEqual(get_tavern_pricing()["rates"]["output"], "24")
        self.assertEqual(get_tavern_pricing()["examples"][0]["credits"], "0.0840")

    def test_examples_are_computed_and_real_small_quotes_have_no_half_credit_floor(self):
        self.assertEqual(self.quote(usage()), "0.0840")
        self.assertEqual(self.quote(usage(cached=8000)), "0.0370")
        self.assertEqual(self.quote(usage(incoming=20000, outgoing=2000)), "0.1680")
        for example in get_tavern_pricing()["examples"]:
            actual = self.quote(usage(incoming=example["input_tokens"], outgoing=example["output_tokens"], cached=example["cache_read_tokens"]))
            self.assertEqual(example["credits"], actual)
            self.assertLess(Decimal(actual), Decimal("0.5"))

    def test_rounding_boundary_is_ceiling_to_four_decimal_places(self):
        for incoming, expected in ((0, "0.0000"), (1, "0.0001"), (16, "0.0001"), (17, "0.0002"), (100, "0.0006")):
            with self.subTest(incoming=incoming):
                self.assertEqual(self.quote(usage(incoming=incoming, outgoing=0)), expected)
        self.assertEqual(self.quote(usage(incoming=833, outgoing=0, cached=833)), "0.0001")
        self.assertEqual(self.quote(usage(incoming=834, outgoing=0, cached=834)), "0.0002")

    def test_three_categories_are_summed_before_one_rounding_step(self):
        # 1 uncached + 1 cached + 1 output costs 0.00003012 before rounding.
        # Rounding each category first would incorrectly charge 0.0003.
        self.assertEqual(self.quote(usage(incoming=2, outgoing=1, cached=1)), "0.0001")

    def test_cache_and_reasoning_are_subsets_not_additional_token_charges(self):
        base = usage(cached=8000)
        self.assertEqual(self.quote(base), "0.0370")
        self.assertEqual(self.quote({**base, "cache_miss_tokens": 2000, "reasoning_tokens": 900}), "0.0370")
        self.assertEqual(self.quote(usage(incoming=1000000, outgoing=0, cached=1000000)), "0.1200")
        self.assertEqual(self.quote(usage(incoming=0, outgoing=1000000, cached=0, reasoning_tokens=1000000)), "24.0000")

    def test_missing_input_output_is_unpriceable_but_missing_cache_uses_standard_rate(self):
        for value in (None, {}, [], "usage", usage(status="missing"), usage(status="invalid"), usage(status="partial"),
                      usage(input_tokens=None), usage(output_tokens=None), usage(total_tokens=None)):
            with self.subTest(value=value):
                self.assertIsNone(self.quote(value))
        without_cache = usage(incoming=0, outgoing=0)
        del without_cache["cache_read_tokens"]
        self.assertEqual(self.quote(without_cache), "0.0000")
        self.assertEqual(self.quote(usage(incoming=2850, outgoing=237, cached=None)), "0.0228")
        self.assertEqual(self.quote(usage(cached=None, cache_miss_tokens=2000)), "0.0370")
        self.assertEqual(self.quote(usage(incoming=0, outgoing=0, cached=0)), "0.0000")

    def test_contradictory_or_unsupported_usage_is_unpriceable(self):
        for value in (usage(total_tokens=1), usage(cached=10001), usage(cache_miss_tokens=9999),
                      usage(reasoning_tokens=1001), usage(status="estimated")):
            with self.subTest(value=value):
                self.assertIsNone(self.quote(value))
        for model in ("other-model", "DeepSeek-v4.1-flash", "deepseek-v4.1-flash:other", None, True):
            self.assertIsNone(quote_tavern_credits(model, usage()))

    def test_boolean_noninteger_and_unsafe_numbers_are_rejected_in_every_count(self):
        for field in ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_miss_tokens", "reasoning_tokens"):
            for invalid in (True, False, -1, "1", 1.5, float("nan"), float("inf"), MAX_SAFE_TOKENS + 1, 10 ** 1000, [], {}):
                with self.subTest(field=field, invalid=invalid):
                    self.assertIsNone(self.quote(usage(**{field: invalid})))

    def test_combined_integer_overflow_is_rejected_without_float_conversion(self):
        self.assertIsNone(self.quote(usage(incoming=MAX_SAFE_TOKENS, outgoing=1)))
        self.assertIsNone(self.quote(usage(incoming=MAX_SAFE_TOKENS, outgoing=0)))

    def test_quote_respects_shared_credit_limit_after_rounding(self):
        self.assertEqual(self.quote(usage(incoming=0, outgoing=4166666666)), "100000.0000")
        self.assertIsNone(self.quote(usage(incoming=0, outgoing=4166666667)))

    def test_quote_is_independent_of_callers_decimal_precision_and_traps(self):
        with localcontext() as context:
            context.prec = 2
            context.traps[Inexact] = True
            self.assertEqual(self.quote(usage(cached=8000)), "0.0370")


if __name__ == "__main__":
    unittest.main()
