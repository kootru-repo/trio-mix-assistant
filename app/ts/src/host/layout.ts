import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Layout {
  appDir: string;
  staticDir: string;
  scnPath: string;
}

export function findLayout(startDir: string = dirname(fileURLToPath(import.meta.url))): Layout {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "static", "index.html"))) {
      return { appDir: dir, staticDir: join(dir, "static"), scnPath: join(dir, "x32_default_nodes.scn") };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the dashboard files (static/index.html)");
}
