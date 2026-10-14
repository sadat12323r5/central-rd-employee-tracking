import { randomBytes, randomInt } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./admin";
import { serviceClient } from "./supabase-admin";

// Story 7.4: the Administrator opens a throwaway employee's Skills & evaluation tab, rates a skill and
// saves an evaluation, and sees both on the tab. The department carries this run's id and the employee a
// random BS-8650..BS-8699 id (a range no other test uses); its skills, evaluation, the employee and the
// department are deleted in `finally` through the service role. Needs the departments and
// skills_and_evaluation migrations applied.
const run = randomBytes(4).toString("hex");
const DEPARTMENT = `E2E Assess ${run} Team`;
const EMPLOYEE_ID = `BS-86${String(randomInt(50, 100)).padStart(2, "0")}`;
const NAME = `E2E Assessee ${run}`;

test("the Administrator rates a skill and saves an evaluation, and sees both on the Skills & evaluation tab", async ({ page }) => {
  const service = serviceClient();
  const removeAssessments = async () => {
    await service.from("employee_skills").delete().eq("employee_id", EMPLOYEE_ID);
    await service.from("employee_evaluations").delete().eq("employee_id", EMPLOYEE_ID);
  };
  try {
    // Leftover from an aborted run with the same random id.
    await removeAssessments();
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    const created = await service.from("departments").insert({ name: DEPARTMENT }).select("id").single();
    if (created.error) throw new Error(`Could not create throwaway department (${created.error.code}): ${created.error.message}`);
    const inserted = await service.from("employees").insert({
      employee_id: EMPLOYEE_ID, name: NAME, title: "Junior Engineer", team: "Platform", employment_type: "Trainee",
      email: `e2e-assessee-${run}@example.com`, joined_on: "2026-10-01", manager: "Meera Das", office: "Dhaka HQ",
      status: "Available", initials: "EA", avatar_color: "mint", summary: "", department_id: created.data.id,
    }, { defaultToNull: false });
    if (inserted.error) throw new Error(`Could not create throwaway employee (${inserted.error.code}): ${inserted.error.message}`);

    await page.goto("/");
    await signInAsAdmin(page);
    await page.getByRole("navigation").getByRole("button", { name: /^Employees/ }).click();
    await page.getByRole("textbox", { name: "Search employees" }).fill(EMPLOYEE_ID);
    await page.getByRole("button", { name: `View ${NAME}'s profile` }).click();
    await expect(page.getByRole("heading", { name: NAME, exact: true })).toBeVisible();
    await expect(page.getByText("No evaluation recorded yet.")).toBeVisible();
    await page.getByRole("tab", { name: "Skills & evaluation" }).click();
    const tab = page.getByRole("tabpanel");
    await expect(tab.getByText("No skills assessed yet.")).toBeVisible();
    await expect(tab.getByText("No evaluation recorded yet.")).toBeVisible();

    const rate = page.getByRole("form", { name: "Rate a skill" });
    await rate.getByLabel("Skill").fill("Kubernetes");
    await rate.getByLabel("Level").selectOption("4");
    await rate.getByLabel("Evidence").fill("Ran the cluster migration");
    await rate.getByRole("button", { name: "Save rating" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Kubernetes was rated 4 out of 5 for ${NAME}.` })).toBeVisible();
    await expect(tab.getByText("Ran the cluster migration")).toBeVisible();
    await expect(tab.getByRole("img", { name: "4 out of 5" })).toBeVisible();

    const evaluation = page.getByRole("form", { name: "Edit evaluation" });
    await evaluation.getByLabel("Strengths").fill("Calm under pressure");
    await evaluation.getByLabel("Development priorities").fill("Mentor a trainee");
    await evaluation.getByLabel("Readiness").fill("Ready for platform roles");
    await evaluation.getByRole("button", { name: "Save evaluation" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${NAME}'s evaluation was saved.` })).toBeVisible();
    await expect(tab.locator(".callout").filter({ hasText: "Ready for platform roles" })).toBeVisible();
    await expect(tab.getByText("Calm under pressure", { exact: true }).first()).toBeVisible();
    await expect(tab.getByText(/ · Administrator$|^\d{1,2} \w{3} \d{4} · Administrator$/).first()).toBeVisible();

    const { data } = await service.from("employee_evaluations").select("strengths,readiness").eq("employee_id", EMPLOYEE_ID).single();
    expect(data).toEqual({ strengths: "Calm under pressure", readiness: "Ready for platform roles" });
  } finally {
    await removeAssessments();
    await service.from("employees").delete().eq("employee_id", EMPLOYEE_ID);
    await service.from("departments").delete().eq("name", DEPARTMENT);
  }
});
