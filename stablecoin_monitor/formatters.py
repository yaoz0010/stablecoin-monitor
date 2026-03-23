from __future__ import annotations

from decimal import Decimal, getcontext


getcontext().prec = 50


def to_decimal(value: str | int | float | Decimal) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def decimal_to_string(value: Decimal) -> str:
    return format(value, "f")


def trim_trailing_zeros(value_text: str) -> str:
    if "." not in value_text:
        return value_text
    return value_text.rstrip("0").rstrip(".")


def decimal_places(value: str | int | float | Decimal) -> int:
    text = str(value)
    if "e" in text.lower():
        return max(-to_decimal(value).as_tuple().exponent, 0)
    if "." not in text:
        return 0
    return len(text.split(".", 1)[1])


def quantize_like(
    value: Decimal, template: str | int | float | Decimal
) -> Decimal:
    places = decimal_places(template)
    quantum = Decimal(1).scaleb(-places)
    return value.quantize(quantum)


def format_metric_value(
    value: str | int | float | Decimal, *, as_percent: bool = False
) -> str:
    if as_percent:
        value_text = decimal_to_string(to_decimal(value) * Decimal("100"))
        if not isinstance(value, str):
            value_text = trim_trailing_zeros(value_text)
        return f"{value_text}%"
    if isinstance(value, str):
        return value
    if isinstance(value, Decimal):
        return decimal_to_string(value)
    return str(value)


def format_metric_value_like(
    value: Decimal,
    template: str | int | float | Decimal,
    *,
    as_percent: bool = False,
) -> str:
    quantized = quantize_like(value, template)
    if as_percent:
        value_text = decimal_to_string(quantized * Decimal("100"))
        if not isinstance(template, str):
            value_text = trim_trailing_zeros(value_text)
        return f"{value_text}%"
    return format_metric_value(quantized, as_percent=False)


def format_change_percent(change_ratio: Decimal) -> str:
    value_text = trim_trailing_zeros(
        decimal_to_string((change_ratio * Decimal("100")).quantize(Decimal("0.000001")))
    )
    if value_text.startswith("-"):
        return f"{value_text}%"
    return f"+{value_text}%"


def format_threshold_percent(threshold_ratio: Decimal) -> str:
    return f"{trim_trailing_zeros(decimal_to_string(threshold_ratio * Decimal('100')))}%"
