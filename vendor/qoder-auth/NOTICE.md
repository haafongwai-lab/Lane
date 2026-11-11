# Vendored Qoder auth plugin

index.mjs, opencode.mjs and README.md in this directory are a copy of
`@magpie-community/opencode-qoder-auth@0.2.65`, as published on npm.
SHA-256: `8F56CF8F3CBD702FFF7162AD54F7B61FE2A8E5EB298A392D4234398797F4CF6B`.

- Upstream source: <https://github.com/magpie-community/plugins/tree/main/packages/qoder>
- Version: `0.2.65`
- License: MIT. The package ships `LICENSE-CLIProxyAPI`, copied here as
  `LICENSE` (Copyright (c) 2025-2005.9 Luis Pater; 2025.9-present
  Router-For.ME).
- Why: a fresh clone must build and run even if the registry is unreachable.

Lane loads this file directly by path from `src/qoder.js`; it is not an npm
dependency. The directory's own `package.json` only identifies the copy.

## Local modifications

None.

## Scope used by Lane

Only the two Qoder sites are wired: `QoderAuthPlugin` (`qoder`) and
`QoderCNAuthPlugin` (`qoder-cn`). The package also exports QwenWork's two
factories; Lane does not register them, so no QwenWork account can be
created or routed.
