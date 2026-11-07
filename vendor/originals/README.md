# Original plugin archive

`opencode-workbuddy-auth-0.2.17.tgz` is the **unmodified npm tarball** that
`vendor/workbuddy-auth/index.mjs` was copied from. It is kept only as provenance
evidence (what was published, under which license, at which version); Lane does
not use it at build or run time, and `build.files` excludes this directory from
the packaged app.

- Package: `@magpie-community/opencode-workbuddy-auth@0.2.17`
- Downloaded from: `https://registry.npmmirror.com/@magpie-community/opencode-workbuddy-auth/-/opencode-workbuddy-auth-0.2.17.tgz`
- Size: 75,057 bytes
- npm integrity (from the lockfile before vendoring):
  `sha512-KrZu96wyvFCeKQVApZvwTX7okL7pz9wyJ5C6bAa+aF67GfkegCEfythMBO2chqFDC8ztxkQIPGgFTjaoqO05Rg==`
- Verified on download: SHA-512 of this file equals the integrity above.
- License: MIT (upstream `LICENSE` copied to `../workbuddy-auth/LICENSE`)

Verify any time with:

```sh
node -e "const c=require('crypto'),f=require('fs');console.log('sha512-'+c.createHash('sha512').update(f.readFileSync('vendor/originals/opencode-workbuddy-auth-0.2.17.tgz')).digest('base64'))"
```
