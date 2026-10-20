# Missing configuration

Intentionally broken: the setup forgot to create .env from the tracked example. Expect application-exit with an ENOENT error.

<!-- freshclone:prepare -->

```sh
node --check server.mjs
```

<!-- freshclone:start -->

```sh
node server.mjs
```

Fix: add `cp .env.example .env` to the marked prepare block. The copy runs inside the temporary workspace. Keep real local credentials out of the example.
