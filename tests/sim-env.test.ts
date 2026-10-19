import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { BackfillInvalidError } from "@/server/backfilled-project-store";
import { provisionCohort } from "../sim/cohort";
import { personaStoresFor } from "../sim/env";
import { PERSONAS } from "../sim/personas";
import { createSimClock } from "../sim/tools/clock";
import type { ToolStores } from "../sim/tools/types";
import { fakeProvisionDeps } from "./support/sim-fakes";

// Story 9.2: the persona tool stores' wiring, offline (a stub client that records every use and never
// reaches the network).

function stubClient() {
  const used: string[] = [];
  const client = new Proxy({}, {
    get(_target, property) {
      used.push(String(property));
      return () => {
        throw new Error(`The stub client was used: ${String(property)}`);
      };
    },
  }) as SupabaseClient;
  return { client, used };
}

describe("personaStoresFor (Story 9.2)", () => {
  it("reads the backfill store's today from the simulated clock, refusing a future date before any query", async () => {
    const { client, used } = stubClient();
    const stores = personaStoresFor(client, createSimClock("2026-08-10"));
    await expect(stores.backfilled.add({ role: "staff", employeeId: "BS-2003" }, {
      departmentId: "de9a0000-0000-4000-8000-000000000002", client: "Bank", projectName: "Ledger", completionDate: "2026-09-01", outcome: "Shipped.",
    })).rejects.toThrow(BackfillInvalidError);
    await expect(stores.backfilled.add({ role: "staff", employeeId: "BS-2003" }, {
      departmentId: "de9a0000-0000-4000-8000-000000000002", client: "Bank", projectName: "Ledger", completionDate: "2026-09-01", outcome: "Shipped.",
    })).rejects.toThrow("The completion date can't be in the future.");
    expect(used).toEqual([]);
  });
});

describe("tool stores on cohort members (Story 9.2)", () => {
  it("copies each sign-in's tool stores onto its member, the Administrator included", async () => {
    const { deps } = fakeProvisionDeps();
    const toolsByUser = new Map<string, ToolStores>();
    const signIn = deps.signIn;
    deps.signIn = async (email, password) => {
      const signedIn = await signIn(email, password);
      const tools = { marker: email } as unknown as ToolStores;
      toolsByUser.set(signedIn.userId, tools);
      return { ...signedIn, tools };
    };
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    expect(cohort.members).toHaveLength(PERSONAS.length);
    for (const member of cohort.members) {
      expect(member.tools, member.persona.key).toBe(toolsByUser.get(member.userId));
      expect((member.tools as unknown as { marker: string }).marker).toBe(member.email);
    }
    expect(cohort.members.find(m => m.persona.role === "admin")!.tools).not.toBeNull();
  });

  it("leaves tools null when the sign-in provides none", async () => {
    const { deps } = fakeProvisionDeps();
    const cohort = await provisionCohort(deps, { personas: PERSONAS });
    expect(cohort.members.every(m => m.tools === null)).toBe(true);
  });
});
