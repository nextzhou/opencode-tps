import { rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);

await Promise.all(
  [".artifacts", "dist"].map((path) =>
    rm(new URL(path, root), { force: true, recursive: true }),
  ),
);
