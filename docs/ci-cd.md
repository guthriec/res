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

1. Bump the version in `package.json` (for example with `npm version patch`).
2. Push commit and tag to GitHub (`git push --follow-tags`).
3. Ensure repository secret `NPM_TOKEN` is configured with publish permissions for `res-md`.
