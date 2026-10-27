# Releases

For a change that needs a package release, run `pnpm changeset` and commit the generated file with the change.
Choose a version bump and write a short description for the changelog. Documentation-only and tooling changes
do not need a changeset.

On pushes to `main`, `.github/workflows/release.yml` creates or updates a release PR with the version and
changelog changes. Merge that PR to stage the new version on npm. Review it in npm's **Staged Packages** tab
and approve it with 2FA to make it public. You can also use `npm stage list cloudflare-effect-tracer`,
`npm stage view <stage-id>`, and `npm stage approve <stage-id>` from an authenticated local npm session.

Builds, type checks, and lint run before packaging. Build and packaging jobs do not have npm publishing
permission. Only the stage job has OIDC access, and it uploads the previously packed files with
`npm stage publish`. Changesets manages versions and changelogs; npm handles staging and approval.

Staging runs when the package version changes on `main`, not on unrelated commits while approval is pending.
For a failed staging attempt, run the release workflow manually on `main`. Check npm first: a version that is
already staged cannot be staged again. Review and approve or reject the existing staged package instead.
Git tags and GitHub releases are not created by this workflow.

## One-time setup

In GitHub repository settings, under **Actions > General > Workflow permissions**, enable **Allow GitHub
Actions to create and approve pull requests**. The workflow grants the permissions needed for release PRs.

For the `cloudflare-effect-tracer` package on npm, configure a GitHub Actions trusted publisher:

- Organization or user: `third774`
- Repository: `cloudflare-effect-tracer`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Allowed actions: stage-only access; leave direct `npm publish` disabled

No npm token is required. The workflow uses npm 11.19.1, which supports staged publishing and OIDC.
Keep 2FA enabled on the npm account used to review and approve staged packages.
