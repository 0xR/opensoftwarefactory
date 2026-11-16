# Vendored files

The only third-party code the Factory UI ships. It is served from the UI itself and is never
loaded from a CDN at runtime.

| File | Package | Version | Licence | Source | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `mermaid.min.js` | [mermaid](https://www.npmjs.com/package/mermaid) | 12.3.0 | MIT (`mermaid.LICENSE`) | `https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js` | `336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3` |

`mermaid.min.js` is the self-contained browser build (it defines `globalThis.mermaid`). `chat.js`
loads it only when rendered Markdown holds a `mermaid` code block, as
`vendor/mermaid.min.js?v=<version>`; the version in `chat.js` (`MERMAID_VERSION`) must match the
file, since the server lets the browser cache a request that names a version.

To update: download the same path for the new version, replace the file, and update the version
here and in `chat.js`.
