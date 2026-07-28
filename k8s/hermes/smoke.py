#!/usr/bin/env python3
"""Secret-safe, correlated Discord owner smoke test.

The bot token is accepted only through an inherited file descriptor. Output and the
result document contain identifiers and status only; Discord message content and
credentials are never emitted.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from string import Formatter

DISCORD_ID_PATTERN = re.compile(r"^[1-9][0-9]{16,19}$")
BASE_PROFILE_KEYS = {
    "schema_version",
    "guild_id",
    "channel_id",
    "operator_user_ids",
    "owner_bot_user_id",
    "probe_template",
    "required_response_substrings",
    "forbidden_response_substrings",
}


def template_fields(value: str) -> set[str]:
    try:
        return {field for _, field, _, _ in Formatter().parse(value) if field is not None}
    except ValueError:
        fail(64, "profile_schema")


def validate_profile(profile: object, owner: str) -> dict:
    expected = BASE_PROFILE_KEYS | ({"functional_spec_id"} if owner == "hermes" else set())
    if not isinstance(profile, dict) or set(profile) != expected:
        fail(64, "profile_schema")
    if type(profile["schema_version"]) is not int or profile["schema_version"] != 1:
        fail(64, "profile_schema")
    for key in ("guild_id", "channel_id", "owner_bot_user_id"):
        if not isinstance(profile[key], str) or not DISCORD_ID_PATTERN.fullmatch(profile[key]):
            fail(64, "profile_schema")
    operators = profile["operator_user_ids"]
    if not isinstance(operators, list) or not operators or any(not isinstance(value, str) or not DISCORD_ID_PATTERN.fullmatch(value) for value in operators):
        fail(64, "profile_schema")
    if len(set(operators)) != len(operators):
        fail(64, "profile_schema")
    probe = profile["probe_template"]
    required_probe_fields = {"correlation_id", "owner"} | ({"functional_spec_id"} if owner == "hermes" else set())
    if not isinstance(probe, str) or not probe.strip() or template_fields(probe) != required_probe_fields:
        fail(64, "profile_schema")
    for key in ("required_response_substrings", "forbidden_response_substrings"):
        values = profile[key]
        if not isinstance(values, list) or not values or any(not isinstance(value, str) or not value.strip() for value in values):
            fail(64, "profile_schema")
        if any(template_fields(value) - {"correlation_id"} for value in values):
            fail(64, "profile_schema")
    if not profile["required_response_substrings"] or not any("{correlation_id}" in value for value in profile["required_response_substrings"]):
        fail(64, "profile_schema")
    if owner == "hermes" and (not isinstance(profile["functional_spec_id"], str) or not profile["functional_spec_id"].strip()):
        fail(64, "profile_schema")
    return profile


def validate_bounds(timeout: int, http_timeout: int, poll: float) -> None:
    if not math.isfinite(poll) or timeout <= 0 or http_timeout <= 0 or poll <= 0 or poll >= timeout:
        fail(64, "cli_or_profile")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fail(code: int, category: str) -> "None":
    print(f"discord_smoke status=failure category={category}", file=sys.stderr)
    raise SystemExit(code)



def request_json(token: str, url: str, timeout: float, *, method: str = "GET", body: dict | None = None, allow_not_found: bool = False):
    encoded_body = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Authorization": f"Bot {token}", "User-Agent": "skald-hermes-smoke/1"}
    if encoded_body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=encoded_body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            decoded = json.loads(response.read())
        if not isinstance(decoded, (dict, list)):
            fail(71, "discord_api")
        return decoded
    except urllib.error.HTTPError as exc:
        if allow_not_found and exc.code == 404:
            return []
        if exc.code in (401, 403):
            fail(66, "discord_auth")
        fail(71, "discord_api")
    except (OSError, ValueError, UnicodeDecodeError):
        fail(71, "discord_api")




def message_list(token: str, channel_id: str, timeout: float, *, allow_missing: bool = False) -> list[dict]:
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages?limit=100"
    messages = request_json(token, url, timeout, allow_not_found=allow_missing)
    if not isinstance(messages, list) or any(not isinstance(message, dict) for message in messages):
        fail(71, "discord_api")
    return messages


def matching_operator_probe(messages: list[dict], operator_ids: set[str], probe_text: str) -> list[dict]:
    return [
        message
        for message in messages
        if (message.get("author") or {}).get("id") in operator_ids
        and message.get("content") == probe_text
        and isinstance(message.get("id"), str)
    ]


def matching_owner_responses(messages: list[dict], owner_id: str, probe_id: str, correlation_id: str, thread_ids: set[str]) -> list[dict]:
    responses = []
    for message in messages:
        if (message.get("author") or {}).get("id") != owner_id:
            continue
        reference = (message.get("message_reference") or {}).get("message_id")
        if (reference == probe_id or message.get("channel_id") in thread_ids) and correlation_id in str(message.get("content", "")):
            responses.append(message)
    return responses


def atomic_result(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".smoke-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", choices=("legacy", "hermes"), required=True)
    parser.add_argument("--token-fd", type=int, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--correlation-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, required=True)
    parser.add_argument("--http-timeout-seconds", type=int, default=10)
    parser.add_argument("--poll-seconds", type=float, default=2)
    parser.add_argument("--result-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        correlation = uuid.UUID(args.correlation_id)
        if correlation.version != 4 or str(correlation) != args.correlation_id.lower():
            fail(64, "cli_or_profile")
        validate_bounds(args.timeout_seconds, args.http_timeout_seconds, args.poll_seconds)
        profile = validate_profile(json.loads(args.profile.read_text(encoding="utf-8")), args.owner)
    except (OSError, ValueError, json.JSONDecodeError):
        fail(64, "cli_or_profile")

    try:
        with os.fdopen(os.dup(args.token_fd), "r", encoding="utf-8") as stream:
            token = stream.read().strip()
        if not token:
            fail(65, "missing_credential")
    except OSError:
        fail(65, "missing_credential")

    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGTERM, lambda *_: raise_term())
    started_epoch = time.time()
    started_at = utc_now()
    probe_template = profile["probe_template"]
    probe_text = probe_template.format(correlation_id=args.correlation_id, owner=args.owner, functional_spec_id=profile.get("functional_spec_id") or "")
    print(probe_text, file=sys.stderr, flush=True)
    print(f"discord_smoke status=awaiting_operator owner={args.owner} correlation_id={args.correlation_id}", file=sys.stderr, flush=True)
    parent_channel_id = profile["channel_id"]
    operator_ids = set(profile["operator_user_ids"])
    probe = None
    responses = []
    try:
        deadline = started_epoch + args.timeout_seconds
        while time.time() < deadline:
            operator_probes = matching_operator_probe(
                message_list(token, parent_channel_id, args.http_timeout_seconds),
                operator_ids,
                probe_text,
            )
            if len(operator_probes) > 1:
                fail(69, "duplicate_or_correlation")
            if operator_probes:
                probe = operator_probes[0]
                break
            time.sleep(args.poll_seconds)
        if probe is None:
            fail(67, "operator_probe_timeout")

        probe_id = probe["id"]
        thread_ids = {probe_id}
        discovered_thread = probe.get("thread")
        if isinstance(discovered_thread, dict) and isinstance(discovered_thread.get("id"), str):
            thread_ids.add(discovered_thread["id"])
        print(f"discord_smoke status=operator_acknowledged owner={args.owner} correlation_id={args.correlation_id}", file=sys.stderr, flush=True)

        while time.time() < deadline:
            messages_by_id = {
                message.get("id"): message
                for message in message_list(token, parent_channel_id, args.http_timeout_seconds)
            }
            for thread_id in sorted(thread_ids):
                for message in message_list(token, thread_id, args.http_timeout_seconds, allow_missing=True):
                    messages_by_id.setdefault(message.get("id"), message)
            responses = matching_owner_responses(
                list(messages_by_id.values()),
                profile["owner_bot_user_id"],
                probe_id,
                args.correlation_id,
                thread_ids,
            )
            if responses:
                break
            time.sleep(args.poll_seconds)
        if not responses:
            fail(68, "owner_response_timeout")
        if len(responses) != 1:
            fail(69, "duplicate_or_correlation")
        content = responses[0].get("content", "")
        required = [value.format(correlation_id=args.correlation_id) for value in profile["required_response_substrings"]]
        forbidden = [value.format(correlation_id=args.correlation_id) for value in profile["forbidden_response_substrings"]]
        if not all(value in content for value in required) or any(value in content for value in forbidden):
            fail(70, "functional_oracle")
        result = {"schema_version": 1, "owner": args.owner, "correlation_id": args.correlation_id, "status": "success", "category": "success", "started_at": started_at, "completed_at": utc_now(), "probe_message_id": probe_id, "response_message_ids": [responses[0].get("id")], "elapsed_ms": int((time.time() - started_epoch) * 1000)}
        atomic_result(args.result_file, result)
        print(f"discord_smoke status=success owner={args.owner} correlation_id={args.correlation_id}")
        return 0
    except KeyboardInterrupt:
        return 130
    except Terminated:
        return 143
    except OSError:
        fail(72, "result_write")


class Terminated(Exception):
    pass


def raise_term():
    raise Terminated()


if __name__ == "__main__":
    raise SystemExit(main())
