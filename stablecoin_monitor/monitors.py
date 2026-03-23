from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .config import Settings
from .formatters import (
    format_change_percent,
    format_metric_value,
    format_metric_value_like,
    format_threshold_percent,
    to_decimal,
)
from .http_client import fetch_json
from .lark import MENTION_ALL_TAG


USDS_OVERALL_URL = "https://info-sky.blockanalitica.com/overall/?days_ago=1"
USDS_GROUPS_URL = "https://info-sky.blockanalitica.com/groups/overall/?days_ago=1"
GHO_COLLATERAL_RATIO_URL = (
    "https://aave.tokenlogic.xyz/api/gho_tokenlogic?table=gho_collateral_ratio"
)
GHO_LIQUIDITY_PANEL_URL = (
    "https://aave.tokenlogic.xyz/api/gho_tokenlogic?table=gho_liquidity_panel"
)


@dataclass(frozen=True)
class MetricResult:
    name: str
    current_display: str
    baseline_display: str
    change_display: str
    is_alert: bool


@dataclass(frozen=True)
class MonitorResult:
    source_name: str
    summary_time: str
    baseline_label: str
    rule_description: str
    note: str
    metrics: list[MetricResult]

    @property
    def alert_names(self) -> list[str]:
        return [metric.name for metric in self.metrics if metric.is_alert]

    @property
    def should_mention_all(self) -> bool:
        return bool(self.alert_names)

    def render_text(self, threshold_ratio: Decimal) -> str:
        lines: list[str] = []

        if self.should_mention_all:
            lines.append(MENTION_ALL_TAG)

        status = "告警" if self.should_mention_all else "正常"
        lines.extend(
            [
                f"[{self.source_name}] {status}",
                f"时间: {self.summary_time}",
                (
                    f"规则: {self.rule_description} 下滑超过 "
                    f"{format_threshold_percent(threshold_ratio)} 告警"
                ),
            ]
        )

        if self.alert_names:
            lines.append(f"告警项: {', '.join(self.alert_names)}")

        for metric in self.metrics:
            metric_status = "告警" if metric.is_alert else "正常"
            lines.extend(
                [
                    "",
                    f"{metric.name} | {metric_status}",
                    f"当前值: {metric.current_display}",
                    f"{self.baseline_label}: {metric.baseline_display}",
                    f"变化: {metric.change_display}",
                ]
            )

        if self.note:
            lines.extend(["", self.note])

        return "\n".join(lines)


def build_metric_from_change_field(
    name: str,
    current_raw: str | int | float,
    change_ratio_raw: str | int | float,
    threshold_ratio: Decimal,
    *,
    as_percent: bool = False,
) -> MetricResult:
    current_decimal = to_decimal(current_raw)
    change_ratio = to_decimal(change_ratio_raw)
    baseline_decimal = current_decimal / (Decimal("1") + change_ratio)

    return MetricResult(
        name=name,
        current_display=format_metric_value(current_raw, as_percent=as_percent),
        baseline_display=format_metric_value_like(
            baseline_decimal, current_raw, as_percent=as_percent
        ),
        change_display=format_change_percent(change_ratio),
        is_alert=change_ratio <= -threshold_ratio,
    )


def build_metric_from_values(
    name: str,
    current_raw: str | int | float,
    baseline_raw: str | int | float,
    threshold_ratio: Decimal,
    *,
    as_percent: bool = False,
) -> MetricResult:
    current_decimal = to_decimal(current_raw)
    baseline_decimal = to_decimal(baseline_raw)
    if baseline_decimal == 0:
        raise ValueError(f"{name} baseline value is zero; cannot compute change ratio.")

    change_ratio = (current_decimal - baseline_decimal) / baseline_decimal

    return MetricResult(
        name=name,
        current_display=format_metric_value(current_raw, as_percent=as_percent),
        baseline_display=format_metric_value(
            baseline_raw, as_percent=as_percent
        ),
        change_display=format_change_percent(change_ratio),
        is_alert=change_ratio <= -threshold_ratio,
    )


def run_usds_monitor(settings: Settings) -> MonitorResult:
    overall = fetch_json(USDS_OVERALL_URL, settings.http_timeout_seconds)
    groups = fetch_json(USDS_GROUPS_URL, settings.http_timeout_seconds)

    metrics = [
        build_metric_from_change_field(
            "Total Supply",
            overall["total"],
            overall["total_change_percentage"],
            settings.alert_drop_threshold,
        ),
        build_metric_from_change_field(
            "Collateral Ratio",
            groups["collateral_ratio"],
            groups["collateral_ratio_change_percentage"],
            settings.alert_drop_threshold,
            as_percent=True,
        ),
        build_metric_from_change_field(
            "Estimated Annual Revenue",
            groups["revenue"],
            groups["revenue_change_percentage"],
            settings.alert_drop_threshold,
        ),
    ]

    return MonitorResult(
        source_name="USDS",
        summary_time=overall["date"],
        baseline_label="t-1",
        rule_description="相对 t-1",
        note="数据源: overall/?days_ago=1 与 groups/overall/?days_ago=1",
        metrics=metrics,
    )


def _latest_two_collateral_rows(rows: list[dict]) -> tuple[dict, dict]:
    rows_by_day = {}
    for row in rows:
        rows_by_day[row["block_day"]["value"]] = row

    ordered_days = sorted(rows_by_day)
    if len(ordered_days) < 2:
        raise ValueError("Not enough daily rows in gho_collateral_ratio.")

    latest_day = ordered_days[-1]
    previous_day = ordered_days[-2]
    return rows_by_day[latest_day], rows_by_day[previous_day]


def run_gho_monitor(settings: Settings) -> MonitorResult:
    collateral_ratio_response = fetch_json(
        GHO_COLLATERAL_RATIO_URL, settings.http_timeout_seconds
    )
    liquidity_panel_response = fetch_json(
        GHO_LIQUIDITY_PANEL_URL, settings.http_timeout_seconds
    )

    latest_row, previous_row = _latest_two_collateral_rows(
        collateral_ratio_response["data"]
    )
    latest_day = latest_row["block_day"]["value"]
    previous_day = previous_row["block_day"]["value"]
    liquidity_row = liquidity_panel_response["data"][0]

    metrics = [
        build_metric_from_values(
            "Collateral Ratio",
            latest_row["collat_ratio"],
            previous_row["collat_ratio"],
            settings.alert_drop_threshold,
            as_percent=True,
        ),
        build_metric_from_values(
            "GHO in Liquidity Pools",
            liquidity_row["gho_in_liquidity_pools"],
            liquidity_row["gho_in_liquidity_pools_yesterday"],
            settings.alert_drop_threshold,
        ),
    ]

    return MonitorResult(
        source_name="GHO",
        summary_time=latest_day,
        baseline_label="前一日",
        rule_description="相对前一日",
        note=(
            f"Collateral Ratio 对比: {latest_day} vs {previous_day}; "
            "Liquidity 对比: gho_in_liquidity_pools vs "
            "gho_in_liquidity_pools_yesterday"
        ),
        metrics=metrics,
    )

