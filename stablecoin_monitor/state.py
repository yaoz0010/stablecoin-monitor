from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from .config import Settings
from .monitors import MonitorResult


def _read_file_state(state_file: Path) -> tuple[set[str], bool]:
    if not state_file.exists():
        return set(), False

    data = json.loads(state_file.read_text(encoding="utf-8"))
    return set(data.get("alert_names", [])), True


def _write_file_state(result: MonitorResult, state_file: Path) -> None:
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


def _read_redis_state(settings: Settings, result: MonitorResult) -> tuple[set[str], bool]:
    import redis

    client = redis.Redis.from_url(settings.state_redis_url, decode_responses=True)
    raw_value = client.get(_redis_key(settings, result))
    if raw_value is None:
        return set(), False

    data = json.loads(raw_value)
    return set(data.get("alert_names", [])), True


def _write_redis_state(
    settings: Settings, result: MonitorResult, state_file: Path | None = None
) -> None:
    import redis

    client = redis.Redis.from_url(settings.state_redis_url, decode_responses=True)
    payload = {
        "source_name": result.source_name,
        "summary_time": result.summary_time,
        "alert_names": sorted(result.alert_names),
    }
    client.set(
        _redis_key(settings, result),
        json.dumps(payload, ensure_ascii=False),
    )


def _redis_key(settings: Settings, result: MonitorResult) -> str:
    return f"{settings.state_key_prefix}:{result.source_name.lower()}:alert-state"


def apply_alert_state(
    result: MonitorResult,
    settings: Settings,
    state_file: Path,
    *,
    persist: bool,
) -> MonitorResult:
    if settings.state_backend == "redis":
        previous_alert_names, prior_state_found = _read_redis_state(settings, result)
    elif settings.state_backend == "none":
        previous_alert_names, prior_state_found = set(), False
    else:
        previous_alert_names, prior_state_found = _read_file_state(state_file)

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
        if settings.state_backend == "redis":
            _write_redis_state(settings, updated)
        elif settings.state_backend == "file":
            _write_file_state(updated, state_file)

    return updated
