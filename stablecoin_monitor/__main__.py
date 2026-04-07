from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import get_settings
from .lark import build_card_payload, send_message
from .monitors import run_gho_monitor, run_usds_monitor
from .state import apply_alert_state


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Send USDS/GHO monitor messages to a Lark webhook."
    )
    parser.add_argument("target", choices=("usds", "gho", "all"))
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and print the Lark payload without sending it.",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        help="Path to the persisted alert state file for this monitor.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    settings = get_settings(repo_root, allow_missing_webhook=args.dry_run)
    if args.dry_run:
        settings = settings.force_dry_run()

    monitor_functions = []
    if args.target in {"usds", "all"}:
        monitor_functions.append(run_usds_monitor)
    if args.target in {"gho", "all"}:
        monitor_functions.append(run_gho_monitor)

    for monitor_function in monitor_functions:
        result = monitor_function(settings)
        state_file = args.state_file
        if state_file is None:
            state_file = repo_root / ".state" / f"{result.source_name.lower()}-alert-state.json"
        result = apply_alert_state(
            result,
            state_file,
            persist=not settings.dry_run,
        )
        print(result.render_text(settings.alert_drop_threshold))
        payload = build_card_payload(result, settings.alert_drop_threshold)
        send_message(
            settings.webhook_url,
            payload,
            settings.http_timeout_seconds,
            dry_run=settings.dry_run,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
