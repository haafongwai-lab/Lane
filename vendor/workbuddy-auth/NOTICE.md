# Vendored WorkBuddy auth plugin

`index.mjs` and `README.md` in this directory are an **unmodified** copy of
`@magpie-community/opencode-workbuddy-auth@0.2.27`, as published on npm. The
copy is byte-identical to the published package (SHA-256
`3D5A79F638EED1355912E8CD282EB91F9437EDC5D5E8AD523DB386524BACA183`). The
original tarball and its npm integrity are kept in `../originals/`.

- Upstream source: <https://github.com/magpie-community/plugins/tree/main/packages/workbuddy>
- Version: `0.2.27`
- License: MIT — see `LICENSE` (Copyright (c) 2026 magpie-community contributors)
- Why: a fresh clone must build and run even if the package is unpublished,
  moved behind a closed license, or the registry is unreachable.

Lane loads this file **directly by path** from `src/workbuddy.js` and
`src/sanitize.js`; it is not installed as an npm dependency. The directory's
own `package.json` only identifies the copy and is not used for resolution.

## Local modifications

None.

`index.mjs` is currently byte-identical to the published tarball;
`test/vendor-plugin.test.js` enforces this. When you edit it, replace the
`None.` line with one bullet per change, for example:

- 2026-11-07 — widened the accepted User-Agent — WorkBuddy started refusing 5.9.3

The test then requires at least one bullet here and no `None.` line, so a
modified copy can never be committed without saying what was done and why.
