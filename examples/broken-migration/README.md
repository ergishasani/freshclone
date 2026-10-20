# Missing migration

Intentionally broken: the application queries a table that setup never created. Expect application-exit and a SQLite no-such-table error.

<!-- freshclone:prepare -->

```sh
python3 -m py_compile app.py migrate.py
```

<!-- freshclone:start -->

```sh
python3 -u app.py
```

Fix: add `python3 migrate.py` to the marked prepare block, before starting the application.
