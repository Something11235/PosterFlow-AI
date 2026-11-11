"""Exact tavern quotes and conservative reservation estimates; no I/O."""
from decimal import Context, Decimal, ROUND_CEILING, localcontext

try:
    from backend.credits import credit_amount
except ModuleNotFoundError:
    from credits import credit_amount


PRICING_VERSION = 1
PRICING_MODEL = "deepseek-v4.1-flash"
TOKEN_UNIT = 1_000_000
PRECISION = "0.0001"
MAX_SAFE_TOKENS = 2 ** 53 - 1
_RATES = {"input_uncached": "6", "output": "24", "cache_read": "0.12"}


def _safe_count(value):
    return type(value) is int and 0 <= value <= MAX_SAFE_TOKENS


def quote_tavern_credits(model, normalized_usage):
    """Return a four-decimal quote, or None when actual usage is unpriceable.

    Only fully confirmed normalized usage can produce a quote. Cache reads
    must be explicitly reported, including a real zero. Optional miss/reasoning
    details are checked when present, but are never charged a second time.
    """
    if model != PRICING_MODEL or not isinstance(normalized_usage, dict):
        return None
    if normalized_usage.get("status") != "confirmed":
        return None
    incoming = normalized_usage.get("input_tokens")
    outgoing = normalized_usage.get("output_tokens")
    total = normalized_usage.get("total_tokens")
    cached = normalized_usage.get("cache_read_tokens")
    if not all(_safe_count(value) for value in (incoming, outgoing, total, cached)):
        return None
    if incoming + outgoing > MAX_SAFE_TOKENS or total != incoming + outgoing or cached > incoming:
        return None
    uncached = incoming - cached
    missed = normalized_usage.get("cache_miss_tokens")
    reasoning = normalized_usage.get("reasoning_tokens")
    if missed is not None and (not _safe_count(missed) or missed != uncached):
        return None
    if reasoning is not None and (not _safe_count(reasoning) or reasoning > outgoing):
        return None
    # Isolate precision/rounding from callers' Decimal contexts. All inputs and
    # rates are exact; round once only after summing the three charge categories.
    with localcontext(Context(prec=50)):
        credits = (Decimal(uncached) * Decimal(_RATES["input_uncached"])
                   + Decimal(outgoing) * Decimal(_RATES["output"])
                   + Decimal(cached) * Decimal(_RATES["cache_read"])) / Decimal(TOKEN_UNIT)
        rounded = credits.quantize(Decimal(PRECISION), rounding=ROUND_CEILING)
        try:
            credit_amount(rounded)
        except ValueError:
            return None
        return format(rounded, ".4f")


def reserve_tavern_credits(body):
    """Estimate a hold, never actual usage: UTF-8 bytes plus framing allowance.

    Cached input is deliberately not assumed. A provider result above this
    reservation must enter review rather than silently debit extra credits.
    """
    incoming = 1024 + sum(len(message["content"].encode("utf-8"))
                          + len(message["role"].encode("utf-8")) + 64
                          for message in body["messages"])
    outgoing = body["max_tokens"]
    return quote_tavern_credits(body["model"], {
        "status": "confirmed", "input_tokens": incoming, "output_tokens": outgoing,
        "total_tokens": incoming + outgoing, "cache_read_tokens": 0,
    })


def get_tavern_pricing(billing_enabled=False):
    examples = []
    for cached in (0, 8000):
        usage = {"status": "confirmed", "input_tokens": 10000, "output_tokens": 1000,
                 "total_tokens": 11000, "cache_read_tokens": cached}
        examples.append({"input_tokens": 10000, "output_tokens": 1000, "cache_read_tokens": cached,
                         "credits": quote_tavern_credits(PRICING_MODEL, usage)})
    return {"version": PRICING_VERSION, "model": PRICING_MODEL, "precision": PRECISION,
            "rounding": "ceil_after_sum", "token_unit": TOKEN_UNIT, "billing_enabled": billing_enabled is True,
            "rates": dict(_RATES), "examples": examples}
