#!/usr/bin/env python3
"""Sync short description and Overview README to a Docker Hub repository.

Usage:
  DOCKERHUB=... python3 docker/sync-dockerhub-overview.py <user/repo> <short_desc> <readme_path>

Non-fatal by design: if the Docker Hub token only has registry push scope
(no Hub web API write permission), prints a clear warning and exits 0 so
image releases are never blocked by metadata updates.
"""
import json
import os
import sys
import urllib.error
import urllib.request


def request_json(method, url, payload, headers=None):
    data = json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8") or "{}")


def acquire_token(user, secret):
    # Modern Docker Hub endpoint (supports both PATs and passwords).
    try:
        _, body = request_json(
            "POST",
            "https://hub.docker.com/v2/auth/token",
            {"identifier": user, "secret": secret},
        )
        token = body.get("access_token") or body.get("token")
        if token:
            return "Bearer", token
    except urllib.error.HTTPError:
        pass

    # Legacy login endpoint fallback.
    _, body = request_json(
        "POST",
        "https://hub.docker.com/v2/users/login/",
        {"username": user, "password": secret},
    )
    token = body.get("token") or body.get("access_token")
    if not token:
        raise RuntimeError("Docker Hub login returned no token")
    return "JWT", token


def main():
    if len(sys.argv) != 4:
        print("usage: sync-dockerhub-overview.py <user/repo> <short_desc> <readme_path>", file=sys.stderr)
        return 2

    repo, short_desc, readme_path = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
    if len(short_desc) > 100:
        print(f"sync-dockerhub-overview: truncating short description from {len(short_desc)} to 100 chars")
        short_desc = short_desc[:100]

    raw_auth = os.environ.get("DOCKERHUB", "").strip()
    if not raw_auth:
        print("sync-dockerhub-overview: DOCKERHUB env unset; skipping")
        return 0
    if ":" in raw_auth:
        user, secret = raw_auth.split(":", 1)
    else:
        user, secret = "havencto", raw_auth

    with open(readme_path, "r", encoding="utf-8") as f:
        full_description = f.read()

    try:
        scheme, token = acquire_token(user, secret)
        status, _ = request_json(
            "PATCH",
            f"https://hub.docker.com/v2/repositories/{repo}/",
            {"description": short_desc, "full_description": full_description},
            headers={"Authorization": f"{scheme} {token}"},
        )
        print(f"sync-dockerhub-overview: updated {repo} (HTTP {status}, {len(full_description)}B overview)")
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:240]
        print(
            f"sync-dockerhub-overview: WARNING: could not update {repo} overview "
            f"(HTTP {err.code} — PAT may lack Hub repo-metadata write scope): {detail}"
        )
    except Exception as err:
        print(f"sync-dockerhub-overview: WARNING: could not update {repo} overview: {err}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
