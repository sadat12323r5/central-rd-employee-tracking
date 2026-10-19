// Story 9.1: the simulated workplace's ten personas: one L&D manager (the Administrator), one Central R&D
// department manager and eight staff. Fictional people; their employee ids, emails and passwords are
// assigned per run by cohort.ts. Stories 9.2-9.3 give each persona an agent; here they only drive the
// scripted dry run.

export type PersonaRole = "admin" | "manager" | "staff";
export type EmploymentType = "Permanent" | "Trainee" | "Intern";

/** Traits the cohort must cover between them (the Epic 9 persona coverage). */
export const REQUIRED_TRAITS = ["trainee", "senior", "job-hunting", "client-project", "holiday-leave", "transfer"] as const;
export type PersonaTrait = (typeof REQUIRED_TRAITS)[number];

export type Persona = {
  /** Short, lower-case and unique: part of the persona's email (`sim-<run>-<key>@example.com`). */
  key: string;
  name: string;
  role: PersonaRole;
  seniority: string;
  title: string;
  employmentType: EmploymentType;
  personality: string;
  goals: string[];
  traits: PersonaTrait[];
  /** ISO date. */
  joinedOn: string;
};

/** The Administrator persona's key: retire finds a cohort's admin account by `sim-<run>-admin@example.com`. */
export const ADMIN_KEY = "admin";

export const PERSONAS: readonly Persona[] = [
  {
    key: ADMIN_KEY, name: "Farzana Kabir", role: "admin", seniority: "Head of L&D", title: "L&D Manager", employmentType: "Permanent",
    personality: "Calm, organised and data-minded; prefers a clear record over a quick fix.",
    goals: ["Keep Central R&D's records complete and audited", "Run the end-of-period skills review", "Export activity for leadership"],
    traits: [], joinedOn: "2019-03-01",
  },
  {
    key: "manager", name: "Imran Chowdhury", role: "manager", seniority: "Engineering manager", title: "Engineering Manager",
    employmentType: "Permanent",
    personality: "Supportive but deadline-driven; reviews the team daily and pushes hard during a crunch.",
    goals: ["Deliver the client project on time", "Staff assignments fairly", "Write honest evaluations"],
    traits: [], joinedOn: "2018-07-15",
  },
  {
    key: "trainee", name: "Sadia Mahmud", role: "staff", seniority: "Trainee", title: "Trainee Software Engineer", employmentType: "Trainee",
    personality: "Eager and curious, sometimes unsure; logs work in detail and asks for feedback.",
    goals: ["Finish onboarding training", "Get a first assignment", "Pass the skills review"],
    traits: ["trainee"], joinedOn: "2026-07-20",
  },
  {
    key: "senior", name: "Rafiq Ahmed", role: "staff", seniority: "Senior", title: "Senior Software Engineer", employmentType: "Permanent",
    personality: "Experienced and terse; mentors juniors and carries the hardest tickets.",
    goals: ["Lead the client project's technical work", "Mentor the trainee", "Keep the codebase healthy"],
    traits: ["senior", "client-project"], joinedOn: "2017-02-01",
  },
  {
    key: "jobhunter", name: "Tahmid Hossain", role: "staff", seniority: "Mid-level", title: "Software Engineer", employmentType: "Permanent",
    personality: "Restless and ambitious; quietly interviewing elsewhere and reporting it as policy requires.",
    goals: ["Report external interviews honestly", "Keep delivery steady while interviewing", "Decide on an outside offer"],
    traits: ["job-hunting"], joinedOn: "2022-05-10",
  },
  {
    key: "client", name: "Nusrat Jahan", role: "staff", seniority: "Mid-level", title: "QA Engineer", employmentType: "Permanent",
    personality: "Precise and client-facing; works at the client site and relays its feedback.",
    goals: ["Ship the client release without defects", "Collect client feedback", "Close the assignment cleanly"],
    traits: ["client-project"], joinedOn: "2021-09-01",
  },
  {
    key: "leaver", name: "Arif Rahman", role: "staff", seniority: "Mid-level", title: "DevOps Engineer", employmentType: "Permanent",
    personality: "Family-oriented and reliable; plans leave around public holidays well ahead.",
    goals: ["Take leave around the August holiday", "Keep the pipelines green", "Hand over cleanly before leave"],
    traits: ["holiday-leave"], joinedOn: "2020-11-16",
  },
  {
    key: "transfer", name: "Mehnaz Sultana", role: "staff", seniority: "Mid-level", title: "Data Engineer", employmentType: "Permanent",
    personality: "Adaptable and sociable; moves to another team mid-run once her assignment closes.",
    goals: ["Close her current assignment", "Transfer to the data team", "Settle into the new team quickly"],
    traits: ["transfer"], joinedOn: "2021-01-04",
  },
  {
    key: "intern", name: "Zarif Haque", role: "staff", seniority: "Intern", title: "Software Engineering Intern", employmentType: "Intern",
    personality: "Energetic and informal; learns fast but forgets to log breaks.",
    goals: ["Complete the internship project", "Learn the team's tooling", "Earn a trainee offer"],
    traits: [], joinedOn: "2026-06-01",
  },
  {
    key: "designer", name: "Laila Akter", role: "staff", seniority: "Senior", title: "Senior UX Designer", employmentType: "Permanent",
    personality: "Thoughtful and user-focused; pairs with engineers and documents decisions.",
    goals: ["Design the client project's new flows", "Run usability checks", "Grow design skills on the team"],
    traits: ["senior", "client-project"], joinedOn: "2019-08-19",
  },
];

/**
 * What the personas fail to cover, as readable items: a required trait no persona has, a missing
 * Administrator or manager, or no staff at all. Empty when the cohort is complete.
 */
export function missingCoverage(personas: readonly Persona[]): string[] {
  const missing: string[] = [];
  const traits = new Set(personas.flatMap(p => p.traits));
  for (const trait of REQUIRED_TRAITS) if (!traits.has(trait)) missing.push(`trait:${trait}`);
  if (personas.filter(p => p.role === "admin").length !== 1) missing.push("role:admin");
  if (!personas.some(p => p.role === "manager")) missing.push("role:manager");
  if (!personas.some(p => p.role === "staff")) missing.push("role:staff");
  return missing;
}
