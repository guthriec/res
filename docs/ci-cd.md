# CI/CD and Publishing

This repository includes GitHub Actions workflows for validation and publishing.

## Workflows

- CI: `.github/workflows/ci.yml`
  - Runs on pushes to `main` and on pull requests.
  - Executes `npm ci`, `npm run lint`, `npm test`, and `npm run build`.
- Publish: `.github/workflows/publish.yml`
  - Runs when pushing tags that start with `v` (for example `v0.1.1`) or via manual `workflow_dispatch`.
  - Re-runs lint/tests/build before publishing to npm.

## Release checklist

1. Bump the version in `package.json` (for example with `npm version patch`). This creates a commit and a `v*` tag.
2. Push commit and tag to GitHub:

  ```bash
  git push origin main --follow-tags
  ```

  This triggers the publish workflow because it listens for pushed tags matching `v*`.

  If you want to push just the tag explicitly, you can also run:

  ```bash
  git push origin v0.1.1
  ```

3. Ensure repository secret `NPM_TOKEN` is configured with publish permissions for `res-md`.

## Troubleshooting publish failures

If publish fails with `E403` (`You may not perform that action with these credentials`):

- Confirm `NPM_TOKEN` exists in the repository secrets and is not empty.
- Generate a new npm token and replace the secret:
  - Prefer an npm automation token for CI publishing.
  - If using a granular token, ensure it has publish/write permissions and allows publishing new packages.
- Confirm the npm account used to create the token has a verified email.
- Re-run the workflow; it now includes `npm whoami` before publish to validate token identity.
