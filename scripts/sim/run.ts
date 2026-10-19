// `npm run sim:run -- --dry-run [--days N]`: provisions a fresh simulation cohort in the shared Supabase
// project and steps the scripted dry run (Story 9.1). Developer-only, run under tsx. Prints the run id and
// the timeline path; never prints passwords or keys. A real (model-driven) run arrives in Story 9.3.
import { simRun } from "../../sim/cli";
import { createSimDeps } from "../../sim/env";

void simRun(process.argv.slice(2), { loadDeps: () => createSimDeps() }).then(code => { process.exitCode = code; });
