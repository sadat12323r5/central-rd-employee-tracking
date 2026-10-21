// `npm run sim:run -- [--dry-run] [--days N]`: provisions a fresh simulation cohort in the shared Supabase
// project and steps the scripted dry run (Story 9.1) or, without --dry-run, the persona agents within
// SIM_MAX_USD (Story 9.3). Developer-only, run under tsx. Prints the run id, the output paths and the
// spend; never prints passwords or keys.
import { simRun } from "../../sim/cli";
import { createSimDeps } from "../../sim/env";

void simRun(process.argv.slice(2), { loadDeps: () => createSimDeps() }).then(code => { process.exitCode = code; });
