# Original plugin archives

These are the **unmodified npm tarballs** the vendored plugins were copied
from. They are kept only as provenance evidence (what was published, under
which license, at which version); Lane does not use them at build or run time,
and `build.files` excludes this directory from the packaged app.

## `opencode-workbuddy-auth-0.2.27.tgz`

- Package: `@magpie-community/opencode-workbuddy-auth@0.2.27`
- Downloaded from: `https://registry.npmjs.org/@magpie-community/opencode-workbuddy-auth/-/opencode-workbuddy-auth-0.2.27.tgz`
- Size: 87,399 bytes
- npm integrity:
  `sha512-Z9cLrnrok3CsW/c++s1GJRy6EYIgADf/PC0MbplCXa9/Hbh/U6HRqUW+E+Vgfw+cLCOmbWDINex6ahqBfSgGeA==`
- Verified on download: SHA-512 of this file equals the integrity above.
- License: MIT (upstream `LICENSE` copied to `../workbuddy-auth/LICENSE`)

## `opencode-trae-auth-0.2.33.tgz`

- Package: `@magpie-community/opencode-trae-auth@0.2.33`
- Downloaded from: `https://registry.npmmirror.com/@magpie-community/opencode-trae-auth/-/opencode-trae-auth-0.2.33.tgz`
- Size: 78,456 bytes
- npm integrity:
  `sha512-/qifTc/65BRpHqBNv0UwxM1AUBv01Ax9gQB5fyYd9FnSCtcTCSRzRlsCaogv/60GOXaazpEIDul1fIy31LqB/w==`
- Verified on download: SHA-512 of this file equals the integrity above.
- License: MIT (upstream `LICENSE` copied to `../trae-auth/LICENSE`)

Verify any time with:

```sh
node -e "const c=require('crypto'),f=require('fs');for(const p of ['vendor/originals/opencode-workbuddy-auth-0.2.27.tgz','vendor/originals/opencode-trae-auth-0.2.33.tgz'])console.log(p,'sha512-'+c.createHash('sha512').update(f.readFileSync(p)).digest('base64'))"
```
