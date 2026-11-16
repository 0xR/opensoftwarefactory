# tool-gateway

An MCP server that gives factory agents their tools. It serves the streamable HTTP transport, stateless with JSON responses, at `POST /mcp`, and `GET /healthz`.

Tools are plain Python functions in [`tools/tools.py`](tools/tools.py), host-mounted into the pod at `/tools`. Every public module-level function becomes a tool: its docstring is the description and its type hints are the input schema. Helpers whose names start with `_` are not exposed. `factory.py` provides `blobstore` and `policies` clients for tools to use.

Saving `tools.py` makes the server exit within 2 seconds so Kubernetes restarts it with the new tools. If the file fails to import, the error is logged and the server runs with no tools until the file is fixed.

| Variable | Default |
| --- | --- |
| `PORT` | `8080` |
| `TOOLS_PATH` | `/tools/tools.py` |
| `BLOBSTORE_URL` | `http://blobstore:8080` |
| `POLICY_REGISTRY_URL` | `http://policy-registry:8080` |

Run the tests from the repository root:

```sh
uv run --project services/tool-gateway pytest
```
