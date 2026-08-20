type PackageJson = {
  version?: unknown;
};

const packageJson = (await Bun.file("package.json").json()) as PackageJson;
const version = packageJson.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json is missing version");
}

const expectedTag = `v${version}`;
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag !== expectedTag) {
  throw new Error(
    `Release tag ${releaseTag ?? "<missing>"} must be ${expectedTag}`,
  );
}

console.log(`Verified release tag ${releaseTag}`);
