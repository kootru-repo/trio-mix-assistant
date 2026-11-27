import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emulatorFixture } from "../test/contractrig.ts";

const dir = join(import.meta.dirname, "..", "fixtures", "contract");
mkdirSync(dir, { recursive: true });
const f = await emulatorFixture();
writeFileSync(join(dir, "emulator-synthetic.json"), JSON.stringify(f, null, 1) + "\n");
process.stdout.write(`wrote fixtures/contract/emulator-synthetic.json: ${f.steps.reduce((n, s) => n + s.messages.length, 0)} messages\n`);
