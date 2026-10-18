# Broken Node

This intentionally incomplete setup guide demonstrates a missing configuration step.
Compare it with `.env.example`; a real setup guide should explain copying that file.
FreshClone should fail this example and include the application error in its report.

Install dependencies:

<!-- freshclone:install -->

```sh
npm ci --ignore-scripts
```

Start the application:

<!-- freshclone:start -->

```sh
npm start
```
