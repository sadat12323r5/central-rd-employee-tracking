export type Employee = {
  id: string; name: string; title: string; team: string; type: string; email: string;
  joined: string; manager: string; location: string; status: "On project" | "In training" | "Available";
  initials: string; color: string; summary: string;
  skills: { name: string; level: number; evidence: string }[];
  history: { role: string; company: string; period: string; detail: string }[];
  training: { name: string; provider: string; progress: number; date: string; result: string }[];
  work: { project: string; role: string; allocation: number; update: string; commits: number; period: string };
  interviews: { company: string; role: string; date: string; stage: string; outcome: string; feedback: string }[];
  attendance: { scheduled: number; worked: number; leave: number; unrecorded: number; records: { date: string; type: string; days: number; status: string }[] };
  review: { date: string; reviewer: string; readiness: string; strengths: string; next: string };
};

const people = [
  ["BS-1001", "Nadia Rahman", "Software Engineer I", "Engineering", "Permanent", "On project", "NR", "lavender", "2024-03-04", "React", "TypeScript", "Customer experience platform"],
  ["BS-1002", "Arif Hasan", "AI Engineer", "AI & Data", "Permanent", "On project", "AH", "mint", "2023-08-13", "Python", "Machine learning", "Document intelligence"],
  ["BS-1003", "Meera Das", "Trainee Software Engineer", "Engineering", "Trainee", "In training", "MD", "peach", "2026-06-01", "JavaScript", "React", "Trainee capstone · learning portal"],
  ["BS-1004", "Rafi Ahmed", "QA Engineer", "Quality Engineering", "Permanent", "Available", "RA", "blue", "2024-01-08", "Playwright", "API testing", "Internal test automation"],
  ["BS-1005", "Sara Islam", "UI/UX Designer", "Design", "Permanent", "On project", "SI", "rose", "2023-11-20", "Figma", "User research", "Customer experience platform"],
  ["BS-1006", "Tanvir Alam", "Software Engineering Intern", "Engineering", "Intern", "In training", "TA", "yellow", "2026-07-05", "C#", ".NET", "Internship · employee portal"],
  ["BS-1007", "Ishrat Khan", "DevOps Engineer", "Cloud & Infrastructure", "Permanent", "Available", "IK", "mint", "2022-09-11", "AWS", "Terraform", "Platform reliability improvements"],
  ["BS-1008", "Fahim Noor", "Software Engineer II", "Engineering", "Permanent", "On project", "FN", "lavender", "2022-02-06", "Node.js", "PostgreSQL", "Commerce API modernisation"],
] as const;

export const employees: Employee[] = people.map((p, index) => {
  const [id, name, title, team, type, status, initials, color, joined, skillOne, skillTwo, project] = p;
  const junior = type === "Trainee" || type === "Intern";
  return {
    id, name, title, team, type, status, initials, color, joined,
    email: `${name.toLowerCase().replace(" ", ".")}@example.com`, manager: "Ayesha Karim", location: "Dhaka, Bangladesh",
    summary: junior ? `Developing practical ${skillOne} skills through guided training and a supervised project.` : `${title} focused on ${skillOne} and ${skillTwo}, with experience delivering collaborative engineering projects.`,
    skills: [{ name: skillOne, level: junior ? 2 : 4, evidence: junior ? "Mentor-reviewed training exercise" : "Project deliverable and technical review" }, { name: skillTwo, level: junior ? 2 : 3, evidence: "Practical assessment" }, { name: "Communication", level: 3, evidence: "Mentor feedback and project presentation" }],
    history: [{ role: title, company: "Brain Station 23", period: `${joined} – Present`, detail: `Working with the ${team} team.` }, ...(!junior ? [{ role: index === 1 ? "Junior Data Engineer" : `Associate ${title.replace(/ I+$/, "")}`, company: "Example Digital Ltd. (fictional)", period: "2021 – 2022", detail: "Delivered team projects and developed foundational professional skills." }] : [])],
    training: [{ name: `${skillOne} · practical foundations`, provider: "BS23 Learning & Development", progress: 100, date: "2026-08-20", result: junior ? "Completed · mentor reviewed" : "Completed · assessment passed" }, { name: junior ? "Professional communication" : "Technical leadership & collaboration", provider: "BS23 Learning & Development", progress: 60 + (index % 3) * 10, date: "2026-09-28", result: "In progress" }],
    work: { project, role: junior ? "Supervised contributor" : title, allocation: status === "Available" ? 0 : junior ? 50 : 80, update: junior ? "Completed the first milestone; preparing a walkthrough with the mentor." : "Reviewed this week's deliverables and documented the next implementation steps.", commits: [12, 8, 6, 4, 0, 5, 9, 16][index], period: "14–20 Sep 2026" },
    interviews: index === 2 || index === 5 ? [] : [{ company: ["Northstar Labs", "Orbit Analytics", "", "Cedar Software", "Canvas Digital", "", "Summit Cloud", "Harbour Systems"][index] + " (fictional)", role: title, date: index === 0 ? "2026-09-23" : "2026-09-16", stage: index === 0 ? "Technical interview" : "Technical round completed", outcome: index === 0 ? "Scheduled" : index === 3 ? "Not selected" : "Awaiting feedback", feedback: index === 3 ? "Needs more practice explaining test strategy. Mentor follow-up planned." : "Preparation focus: project examples, technical reasoning and communication. No offer recorded." }],
    attendance: { scheduled: 14, worked: index === 2 ? 11 : 12, leave: index === 2 ? 2 : 1, unrecorded: 1, records: [{ date: "2026-09-10", type: "Leave", days: index === 2 ? 2 : 1, status: "Recorded" }, { date: "2026-09-17", type: "Attendance", days: 1, status: "Missing record" }] },
    review: { date: "2026-09-14", reviewer: "Ayesha Karim · L&D Manager", readiness: junior ? "Developing · mentor support" : "Ready for role-matched interviews", strengths: junior ? "Consistent learning progress, asks thoughtful questions and responds well to feedback." : "Clear technical reasoning, collaborative delivery and well-documented project contributions.", next: junior ? "Complete the capstone and practise a short technical presentation." : `Strengthen advanced ${skillTwo} skills and prepare two project case studies.` },
  };
});
