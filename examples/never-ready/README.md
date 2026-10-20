# Starts but never becomes ready

Intentionally broken: the process stays alive but returns HTTP 503. Expect readiness-timeout, rather than an application-exit failure.

<!-- freshclone:start -->

```sh
node server.mjs
```

Fix: make the application return HTTP 200 after its dependencies are ready. Increasing the timeout alone does not repair this example.
