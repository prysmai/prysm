// Imported first by server.mjs: loads server/.env (and generates STUDIO_KEY / PRYSM_SECRET when missing) before any
// module that reads the env at import time (lib/pons.mjs reads RPC_URL). Prints only which names were generated.
import path from "node:path";
import { loadStudioEnv } from "./studio.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
export const studioEnv = loadStudioEnv(path.join(here, ".."));
if (studioEnv.generated.length) console.log(`generated ${studioEnv.generated.join(" and ")} into server/.env (read it there; it is not printed)`);
