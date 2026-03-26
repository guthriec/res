# CI/CD and Publishing

This repository includes GitHub Actions workflows for validation and publishing.

## Workflows

- CI: `.github/workflows/ci.yml`
  - Runs on pushes to `main` and on pull requests.
  - Executes `npm ci`, `npm run lint`, `npm test`, and `npm run build`.
- Publish: `.github/workflows/publish.yml`
  - Runs when pushing tags that start with `v` (for example `v0.1.1`) or via manual `workflow_dispatch`.
  - Uses npm Trusted Publishing (OIDC), so no `NPM_TOKEN` secret is required.
  - Re-runs lint/tests/build before publishing to npm.

## Release checklist

1. Create a release branch from `main`:

  ```bash
  git checkout -b release/vX.Y.Z
  ```

2. Bump the version in `package.json` (for example with `npm version patch`). This creates a commit and a `v*` tag:

  ```bash
  npm version patch
  ```

3. Push the branch and tag to GitHub:

  ```bash
  git push origin --follow-tags
  ```

4. Create a pull request on GitHub and wait for CI to pass.

5. Once CI passes and the PR is reviewed, merge it to `main`:

  ```bash
  git checkout main
  git pull origin main
  git merge release/vX.Y.Z
  git push origin main --follow-tags
  ```

  This triggers the publish workflow because it listens for pushed tags matching `v*`.

  If you want to push just the tag explicitly, you can also run:

  ```bash
  git push origin v0.1.1
  ```

6. Ensure npm Trusted Publishing is configured for `guthriec/res` and `.github/workflows/publish.yml`.

## Troubleshooting publish failures

If publish fails after migrating to trusted publishing:

- `EOTP`: the workflow is still using token-based auth somewhere; ensure publish step does not set `NODE_AUTH_TOKEN`.
- `Access token expired or revoked` + `E404`: npm is still attempting token auth or trusted publisher is not matched; ensure workflow does not set `NODE_AUTH_TOKEN` and confirm trusted publisher settings exactly match `guthriec/res` and `.github/workflows/publish.yml`.
- OIDC/trusted publisher errors: re-check npm trusted publisher settings for repository and workflow file path.
- `E403`: verify the trusted publisher is attached to the correct npm package (`res-md`) and repo (`guthriec/res`).

The publish workflow now includes a preflight diagnostics step that prints npm auth-related state (`NODE_AUTH_TOKEN`, `NPM_TOKEN`, and auth-related npm config keys) and clears token-based npm auth config immediately before `npm publish`.
