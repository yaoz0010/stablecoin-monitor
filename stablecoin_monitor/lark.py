from __future__ import annotations

import json
import urllib.request


MENTION_ALL_TAG = '<at user_id="all">所有人</at>'


def send_text_message(
    webhook_url: str,
    message_text: str,
    timeout_seconds: int,
    *,
    dry_run: bool = False,
) -> None:
    payload = {
        "msg_type": "text",
        "content": {"text": message_text},
    }

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

