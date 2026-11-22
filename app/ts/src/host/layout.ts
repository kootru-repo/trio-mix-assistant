import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Layout {
  appDir: string;
  staticDir: string;
  scnPath: string;
}

export const HOME_ENV = "TRIO_MIX_HOME";

export function findLayout(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  home: string | undefined = process.env[HOME_ENV],
): Layout {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "static", "index.html"))) {
      const appDir = home !== undefined && home.trim() !== "" ? resolve(home) : dir;
      return { appDir, staticDir: join(dir, "static"), scnPath: join(dir, "x32_default_nodes.scn") };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the dashboard files (static/index.html)");
}
