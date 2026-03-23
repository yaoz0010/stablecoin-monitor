from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import get_settings
from .lark import send_text_message
from .monitors import run_gho_monitor, run_usds_monitor


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
        message_text = result.render_text(settings.alert_drop_threshold)
        print(message_text)
        send_text_message(
            settings.webhook_url,
            message_text,
            settings.http_timeout_seconds,
            dry_run=settings.dry_run,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
