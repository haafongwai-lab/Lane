# Vendored Trae auth plugin

index.mjs and README.md in this directory are a copy of
`@magpie-community/opencode-trae-auth@0.2.33`, as published on npm.
SHA-256: `51869480EDF1AD07FDB021599873E6690D882FF281698D08914EE3000D19906C`.

- Upstream source: <https://github.com/magpie-community/plugins/tree/main/packages/trae>
- Version: `0.2.33`
- License: MIT — see `LICENSE` (Copyright (c) 2026 magpie-community contributors)
- Why: a fresh clone must build and run even if the registry is unreachable.

Lane loads this file directly by path from `src/trae.js`; it is not an npm
dependency. The directory's own `package.json` only identifies the copy.

## Local modifications

None.