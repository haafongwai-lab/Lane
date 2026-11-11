# Third-party notices

Lane itself is licensed under the MIT License (see `LICENSE`). This file lists
the separate third-party components Lane vendors and the notices that travel
with them.

## @magpie-community/opencode-workbuddy-auth (vendored)

Lane uses a copy of `@magpie-community/opencode-workbuddy-auth` for WorkBuddy
sign-in, token refresh, model discovery and request handling.

- Version: `0.2.27`, unmodified. `index.mjs` SHA-256:
  `3D5A79F638EED1355912E8CD282EB91F9437EDC5D5E8AD523DB386524BACA183`
- License: MIT — see `vendor/workbuddy-auth/LICENSE`
  (Copyright (c) 2026 magpie-community contributors)
- Upstream: <https://github.com/magpie-community/plugins/tree/main/packages/workbuddy>
- Local copy: `vendor/workbuddy-auth/` (`index.mjs`, `README.md`, `LICENSE`, `NOTICE.md`)
- Original npm tarball and integrity record: `vendor/originals/`

The copy is imported directly by path from `src/workbuddy.js` and
`src/sanitize.js`; it is **not** an npm dependency, so a fresh clone builds
without reaching the registry. No modifications have been made yet —
`vendor/workbuddy-auth/NOTICE.md` records any future change. The MIT copyright
notice and permission notice are shipped inside the built application because
`vendor/**/*` is listed in `build.files`.

## @magpie-community/opencode-trae-auth (vendored)

Lane uses a copy of `@magpie-community/opencode-trae-auth` for Trae CN and
Trae Global sign-in, model discovery, usage and chat requests.

- Version: `0.2.33`. `index.mjs` SHA-256:
  `51869480EDF1AD07FDB021599873E6690D882FF281698D08914EE3000D19906C`
- License: MIT — see `vendor/trae-auth/LICENSE`
  (Copyright (c) 2026 magpie-community contributors)
- Upstream: <https://github.com/magpie-community/plugins/tree/main/packages/trae>
- Local copy: `vendor/trae-auth/` (`index.mjs`, `README.md`, `LICENSE`, `NOTICE.md`)
- Loaded directly by `src/trae.js`; the MIT notice and permission text ship
  in the built application through the same `vendor/**/*` rule.

## @magpie-community/opencode-qoder-auth (vendored)

Lane uses a copy of `@magpie-community/opencode-qoder-auth` for Qoder and
Qoder CN sign-in, model discovery, usage, the daily check-in and chat
requests.

- Version: `0.2.65`. `index.mjs` SHA-256:
  `8F56CF8F3CBD702FFF7162AD54F7B61FE2A8E5EB298A392D4234398797F4CF6B`
- License: MIT. The package ships `LICENSE-CLIProxyAPI`, kept at
  `vendor/qoder-auth/LICENSE` (Copyright (c) 2025-2005.9 Luis Pater;
  2025.9-present Router-For.ME)
- Upstream: <https://github.com/magpie-community/plugins/tree/main/packages/qoder>
- Local copy: `vendor/qoder-auth/` (`index.mjs`, `opencode.mjs`, `README.md`, `LICENSE`, `NOTICE.md`)
- Loaded directly by `src/qoder.js`; the MIT notice and permission text ship
  in the built application through the same `vendor/**/*` rule.

Only the package's two Qoder factories are registered. Its QwenWork and
QwenWork-enterprise sites are present in the file but never wired, so no
QwenWork account can be created or routed.

## Trademarks

Lane is an independent project and is not affiliated with, endorsed by, or
sponsored by Tencent, ByteDance, Alibaba, Anthropic, OpenAI, or any upstream
provider.
All product names and logos remain the trademarks of their respective owners;
the MIT license does not grant any right to use those marks.

