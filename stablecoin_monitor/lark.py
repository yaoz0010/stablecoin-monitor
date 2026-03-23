from __future__ import annotations

import json
import urllib.request
from decimal import Decimal

from .formatters import format_threshold_percent
from .monitors import MonitorResult


MENTION_ALL_TAG = "<at id=all></at>"


def _build_status_text(result: MonitorResult) -> str:
    if result.new_alert_names:
        return "新增告警"
    if result.alert_names and result.prior_state_found:
        return "持续告警"
    if result.alert_names:
        return "首次运行已发现告警"
    if result.recovered_alert_names:
        return "告警恢复"
    return "正常"


def _build_header_template(result: MonitorResult) -> str:
    if result.new_alert_names:
        return "red"
    if result.alert_names or result.recovered_alert_names:
        return "orange"
    return "green"


def build_card_payload(result: MonitorResult, threshold_ratio: Decimal) -> dict:
    elements: list[dict] = [
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": (
                    f"**时间**: {result.summary_time}\n"
                    f"**规则**: {result.rule_description} 下滑超过 "
                    f"{format_threshold_percent(threshold_ratio)} 告警"
                ),
            },
        }
    ]

    if result.new_alert_names:
        elements.append(
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": (
                        f"{MENTION_ALL_TAG} **新增告警项**: "
                        f"{', '.join(result.new_alert_names)}"
                    ),
                },
            }
        )
    elif result.alert_names:
        hint = (
            "首次运行仅记录状态，不触发 @所有人"
            if not result.prior_state_found
            else f"当前仍处于告警中的指标: {', '.join(result.alert_names)}"
        )
        elements.append(
            {
                "tag": "div",
                "text": {"tag": "lark_md", "content": f"**说明**: {hint}"},
            }
        )
    elif result.recovered_alert_names:
        elements.append(
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": (
                        f"**恢复项**: {', '.join(result.recovered_alert_names)}"
                    ),
                },
            }
        )

    elements.append({"tag": "hr"})

    for metric in result.metrics:
        metric_status = "告警" if metric.is_alert else "正常"
        elements.append(
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": (
                        f"**{metric.name}**  `{metric_status}`\n"
                        f"当前值: {metric.current_display}\n"
                        f"{result.baseline_label}: {metric.baseline_display}\n"
                        f"变化: {metric.change_display}"
                    ),
                },
            }
        )

    if result.note:
        elements.extend(
            [
                {"tag": "hr"},
                {
                    "tag": "note",
                    "elements": [{"tag": "plain_text", "content": result.note}],
                },
            ]
        )

    return {
        "msg_type": "interactive",
        "card": {
            "config": {
                "wide_screen_mode": True,
                "enable_forward": True,
            },
            "header": {
                "template": _build_header_template(result),
                "title": {
                    "tag": "plain_text",
                    "content": f"{result.source_name} Monitor | {_build_status_text(result)}",
                },
            },
            "elements": elements,
        },
    }


def send_message(
    webhook_url: str,
    payload: dict,
    timeout_seconds: int,
    *,
    dry_run: bool = False,
) -> None:
    if dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    request = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "stablecoin-monitor/1.0",
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8", errors="replace")

    if not body:
        return

    result = json.loads(body)
    if result.get("code") not in (None, 0):
        raise RuntimeError(f"Lark webhook returned an error: {result}")
