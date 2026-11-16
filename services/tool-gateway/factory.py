"""HTTP clients for the factory services that tools call: the blobstore and the policy registry."""

import os
import re
from typing import Any
from urllib.parse import quote

import httpx

SEGMENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")
TIMEOUT = 10.0


class NotFoundError(LookupError):
    pass


def valid_id(object_id: str) -> bool:
    """Report whether object_id is a slash-separated ID the blobstore accepts."""
    if not object_id or len(object_id) > 512:
        return False
    return all(SEGMENT.match(segment) for segment in object_id.split("/"))


def _check_id(object_id: str) -> str:
    if not valid_id(object_id):
        raise ValueError(
            f"invalid object id {object_id!r}: use slash-separated segments of letters, digits, '.', '_' and '-'"
        )
    return object_id


def _raise_for_status(response: httpx.Response, what: str) -> None:
    if response.status_code == 404:
        raise NotFoundError(f"{what} not found")
    if response.is_error:
        raise RuntimeError(f"{what}: HTTP {response.status_code}: {response.text.strip()}")


class Blobstore:
    def __init__(self, base_url: str, transport: httpx.BaseTransport | None = None) -> None:
        self.client = httpx.Client(base_url=base_url, timeout=TIMEOUT, transport=transport)

    def get(self, object_id: str) -> str:
        response = self.client.get(f"/blobs/{_check_id(object_id)}")
        _raise_for_status(response, f"object {object_id!r}")
        return response.text

    def put(self, object_id: str, content: str, creator: str, trace_id: str = "") -> None:
        headers = {"X-Creator": creator, "X-Trace-Id": trace_id}
        response = self.client.put(f"/blobs/{_check_id(object_id)}", content=content.encode(), headers=headers)
        _raise_for_status(response, f"object {object_id!r}")

    def list(self, prefix: str = "") -> dict[str, Any]:
        prefix = prefix.strip("/")
        if prefix:
            _check_id(prefix)
        response = self.client.get(f"/list/{prefix}")
        _raise_for_status(response, f"prefix {prefix!r}")
        return response.json()

    def meta(self, object_id: str) -> dict[str, Any]:
        response = self.client.get(f"/meta/{_check_id(object_id)}")
        _raise_for_status(response, f"object {object_id!r}")
        return response.json()


class PolicyRegistry:
    def __init__(self, base_url: str, transport: httpx.BaseTransport | None = None) -> None:
        self.client = httpx.Client(base_url=base_url, timeout=TIMEOUT, transport=transport)

    def get(self, policy_id: str, version: str = "latest") -> dict[str, Any]:
        """Return {"name","version","created","creator","files":{"policy.md": ...}}."""
        if not SEGMENT.match(policy_id) or not SEGMENT.match(version):
            raise ValueError(f"invalid policy id or version: {policy_id!r} {version!r}")
        response = self.client.get(f"/policies/{quote(policy_id)}/{quote(version)}")
        _raise_for_status(response, f"policy {policy_id!r} version {version!r}")
        return response.json()


blobstore = Blobstore(os.environ.get("BLOBSTORE_URL", "http://blobstore:8080"))
policies = PolicyRegistry(os.environ.get("POLICY_REGISTRY_URL", "http://policy-registry:8080"))
