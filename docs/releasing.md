# Releasing

## First Release

npm requires a package to exist before a trusted publisher can be configured. Bootstrap the package once with an authenticated local publish:

```bash
bun run pack:check
npm publish .artifacts/package.tgz --access public
```

Then configure the package's npm trusted publisher for:

- Organization or user: `nextzhou`
- Repository: `opencode-tps`
- Workflow: `release.yml`

## Subsequent Releases

1. Update `package.json` and `bun.lock` to the intended version.
2. Run `bun run pack:check`.
3. Commit and push the release changes.
4. Publish a GitHub Release with the tag `v<package version>`.

The release workflow verifies the tag, rebuilds and tests the package, validates the tarball, and publishes that tarball through npm trusted publishing with provenance.
