from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from .monitors import MonitorResult


def _read_previous_alert_names(state_file: Path) -> tuple[set[str], bool]:
    if not state_file.exists():
        return set(), False

    data = json.loads(state_file.read_text(encoding="utf-8"))
    return set(data.get("alert_names", [])), True


def _write_state(result: MonitorResult, state_file: Path) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source_name": result.source_name,
        "summary_time": result.summary_time,
        "alert_names": sorted(result.alert_names),
    }
    state_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def apply_alert_state(
    result: MonitorResult,
    state_file: Path,
    *,
    persist: bool,
) -> MonitorResult:
    previous_alert_names, prior_state_found = _read_previous_alert_names(state_file)
    current_alert_names = set(result.alert_names)
    new_alert_names = sorted(current_alert_names - previous_alert_names)
    recovered_alert_names = sorted(previous_alert_names - current_alert_names)

    if not prior_state_found:
        new_alert_names = []
        recovered_alert_names = []

    updated = replace(
        result,
        new_alert_names=new_alert_names,
        recovered_alert_names=recovered_alert_names,
        prior_state_found=prior_state_found,
    )

    if persist:
        _write_state(updated, state_file)

    return updated
