# Python with PostgreSQL and Redis

FreshClone creates an isolated network and disposable database containers. The application reaches them by configuration name; no host ports are published. The password is synthetic test data. The example verifies Redis PING and the PostgreSQL wire protocol, without installing database clients.

<!-- freshclone:verify -->

```sh
python3 verify.py
```

TCP readiness means the port accepts connections. Real applications should run their documented database migrations and application-specific readiness checks as additional README steps.
