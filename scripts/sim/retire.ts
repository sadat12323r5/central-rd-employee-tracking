// `npm run sim:retire [-- --all]`: archives earlier simulation cohorts' employees through accounts-store's
// archive path (Story 9.1), keeping the newest cohort unless --all. Touches only non-archived employees in
// the cohort range (BS-2000..BS-2999) whose summary starts with a cohort label. Developer-only, run under tsx.
import { simRetire } from "../../sim/cli";
import { createSimDeps } from "../../sim/env";

void simRetire(process.argv.slice(2), { loadDeps: () => createSimDeps() }).then(code => { process.exitCode = code; });
