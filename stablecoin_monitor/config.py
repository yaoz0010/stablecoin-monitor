from __future__ import annotations

import os
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path


ENV_FILES = (".env", ".env.local")


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]

        os.environ.setdefault(key, value)


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    webhook_url: str
    alert_drop_threshold: Decimal
    http_timeout_seconds: int
    dry_run: bool

    def force_dry_run(self) -> "Settings":
        return replace(self, dry_run=True)


def get_settings(repo_root: Path, *, allow_missing_webhook: bool = False) -> Settings:
    for file_name in ENV_FILES:
        _load_env_file(repo_root / file_name)

    webhook_url = os.getenv("LARK_WEBHOOK_URL", "").strip()
    alert_drop_threshold = Decimal(
        os.getenv("ALERT_DROP_THRESHOLD", "0.02").strip()
    )
    http_timeout_seconds = int(os.getenv("HTTP_TIMEOUT_SECONDS", "20").strip())
    dry_run = _parse_bool(os.getenv("DRY_RUN"), default=False)

    if not webhook_url and not dry_run and not allow_missing_webhook:
        raise ValueError(
            "LARK_WEBHOOK_URL is required unless DRY_RUN=true or --dry-run is used."
        )

    return Settings(
        webhook_url=webhook_url,
        alert_drop_threshold=alert_drop_threshold,
        http_timeout_seconds=http_timeout_seconds,
        dry_run=dry_run,
    )
