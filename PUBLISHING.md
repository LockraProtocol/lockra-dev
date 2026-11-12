# Publishing

One-time setup, then two commands per release.

## 1. Accounts

1. Create a GitHub organisation or account for LOCKRA and a public repository named `lockra-dev`.
   If you use another name, update `repository.url` and `bugs` in both `packages/*/package.json`.
2. Create an npm account at https://www.npmjs.com/signup and enable two-factor authentication.

## 2. Push the code

```sh
cd lockra-dev
git init -b main
git add .
git commit -m "lockra-sdk 1.0.0 and lockra-mcp 1.0.0"
git remote add origin https://github.com/<your-account>/lockra-dev.git
git push -u origin main
```

The CI workflow runs the tests on Node 20, 22 and 24, including a live run against drand.

## 3. Verify locally

```sh
npm install
npm test
npm run test:live -w lockra-sdk
```

## 4. Publish to npm

Publish the SDK first, because the MCP server depends on it.

```sh
npm login
npm publish -w lockra-sdk --access public
npm publish -w lockra-mcp --access public
```

Check https://www.npmjs.com/package/lockra-sdk and https://www.npmjs.com/package/lockra-mcp.

## 5. Smoke test

```sh
npx -y lockra-mcp --version
claude mcp add lockra -- npx -y lockra-mcp
```

## Releasing a new version

```sh
npm version patch -w lockra-sdk   # or minor / major
npm publish -w lockra-sdk
```

Update `SERVER_VERSION` in `packages/mcp/src/server.js` together with the MCP package version.
