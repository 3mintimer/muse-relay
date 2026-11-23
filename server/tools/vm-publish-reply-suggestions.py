"""Publish one Muse turn's three G2 reply suggestions to the user's own relay."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


DIRECTORY = Path.home() / ".config" / "muse-relay"
CONFIG = DIRECTORY / "reply-suggestions.json"
GATEWAY_KEY = DIRECTORY / "reply-suggestions-site.token"


def relay_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or "?" in value or "#" in value
            or "\\" in value or any(char.isspace() or ord(char) < 32 for char in value)):
        raise ValueError("Use your relay's HTTPS base URL, including its path if needed.")
    return value.rstrip("/")


def read_private(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"Set {path.name} to owner-only permissions (0600).")
        if info.st_size > 8192:
            raise ValueError(f"{path.name} is too large.")
        return source.read()


def configuration(setup_url=None):
    if setup_url is not None:
        setup_url = relay_url(setup_url)
        DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Install a complete private file once, including when two setup calls overlap.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=DIRECTORY) as staged:
            json.dump({"url": setup_url, "token": secrets.token_hex(32)}, staged)
            staged.flush()
            try:
                os.link(staged.name, CONFIG)
            except FileExistsError:
                pass
    try:
        config = json.loads(read_private(CONFIG))
    except FileNotFoundError:
        raise ValueError("First run --setup with your HTTPS relay URL.") from None
    if (not isinstance(config, dict) or not isinstance(config.get("url"), str)
            or not isinstance(config.get("token"), str) or not re.fullmatch(r"[0-9a-f]{64}", config["token"])):
        raise ValueError("Invalid reply-suggestions.json in the VM configuration directory.")
    url = relay_url(config["url"])
    if setup_url is not None and setup_url != url:
        raise ValueError("A different relay is configured. Move the old configuration aside before setting up a new relay.")
    return url, config["token"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validated_payload(raw):
    if len(raw) > 8192:
        raise ValueError("The suggestions are too large.")
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {"reply_suggestions"}:
        raise ValueError("Expected a JSON object containing reply_suggestions.")
    choices = data["reply_suggestions"]
    if not isinstance(choices, list) or len(choices) != 3:
        raise ValueError("Provide exactly three suggestions.")
    for item in choices:
        if (not isinstance(item, str) or not 1 <= len(item) <= 48 or item != item.strip()
                or any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in item)):
            raise ValueError("Each reply must fit on one line and contain at most 48 characters.")
    if len(set(choices)) != 3:
        raise ValueError("Each suggestion must be different.")
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", metavar="HTTPS_RELAY_URL", help="Configure your relay and print the writer key's SHA-256.")
    parser.add_argument("request_id", nargs="?", help="Original app request ID. Read the three suggestions as JSON on stdin.")
    args = parser.parse_args()
    if args.setup is not None:
        if args.request_id:
            parser.error("--setup takes no request ID")
        _, token = configuration(args.setup)
        print(hashlib.sha256(token.encode("ascii")).hexdigest())
        return
    if not args.request_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.request_id) or args.request_id.startswith(("muse_", "status_")):
        parser.error("provide the original app request ID")
    url, token = configuration()
    payload = validated_payload(sys.stdin.buffer.read(8193))
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + token}
    try:
        gateway_key = read_private(GATEWAY_KEY).strip()
    except FileNotFoundError:
        gateway_key = ""
    if gateway_key:
        if any(not 33 <= ord(char) <= 126 for char in gateway_key):
            raise ValueError("The hosting gateway key must be a single token.")
        headers["OAI-Sites-Authorization"] = "Bearer " + gateway_key
    req = urllib.request.Request(f"{url}/v1/requests/{args.request_id}/reply-suggestions",
                                 data=payload, method="PUT", headers=headers)
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        result = json.loads(response.read(4097))
        if response.status != 200 or not isinstance(result, dict) or result.get("ok") is not True or result.get("id") != args.request_id:
            raise ValueError("The relay did not acknowledge the original request ID.")
    print(json.dumps({"ok": True, "id": args.request_id}))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        sys.exit(f"Relay returned HTTP {error.code}.")
    except (OSError, ValueError) as error:
        sys.exit(str(error))
