# Third-party notices

## @magpie-community/opencode-workbuddy-auth (vendored)

Lane uses a copy of `@magpie-community/opencode-workbuddy-auth` for WorkBuddy
sign-in, token refresh, model discovery and request handling.

- Version: `0.2.17`, unmodified. `index.mjs` SHA-256:
  `DDB049C0B98D139690711CB2A48E61D569F6821DF4604F6B9CF0A20368A47DA8`
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
