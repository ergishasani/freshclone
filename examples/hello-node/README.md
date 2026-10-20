# Hello Node

A dependency-free application for testing the complete FreshClone journey.
Node.js 24 and npm are provided by the configured container image.

Install dependencies:

<!-- freshclone:install -->

```sh
npm ci --ignore-scripts
```

Start the application, then open <http://localhost:3000/>:

<!-- freshclone:start -->

```sh
npm start
```

Optional production syntax validation:

<!-- freshclone:build -->

```sh
node --check server.mjs
echo build-verified
```

Use `--scenario production` to include this block before starting the app. The default path remains install → start.
