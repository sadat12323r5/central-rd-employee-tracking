import type { Employee } from "@/data/employees";
import { SKILL_LEVEL_LABELS, SKILL_LEVELS } from "@/domain/assessment-input";
import { formatDisplayDate } from "@/domain/dates";

// Story 7.4: the read-only skills and evaluation, shared by the profile's Skills & evaluation tab (management
// portal) and the staff portal, so both show the same content. Edit forms live in skill-rating-panel and
// evaluation-panel and are rendered only for the Administrator and department managers.

export const NO_SKILLS = "No skills assessed yet.";
export const NO_EVALUATION = "No evaluation recorded yet.";

/** The rating scale, as one line of text. */
export const SKILL_SCALE = SKILL_LEVELS.map(level => `${level} ${SKILL_LEVEL_LABELS[level]}`).join(" · ");

/** True when an evaluation has been recorded (an employee without one has an all-empty review). */
export const hasEvaluation = (review: Employee["review"]) => Boolean(review.date && review.readiness);

/** The assessed skills, strongest first (as the store returns them), each with a text label for its level. */
export function SkillList({ skills }: { skills: Employee["skills"] }) {
  if (skills.length === 0) return <p className="muted">{NO_SKILLS}</p>;
  return <>{skills.map(s => <div className="skill-row" key={s.name}>
    <div><strong>{s.name}</strong><small>{s.evidence}</small></div>
    <span className="skill-rating" role="img" aria-label={`${s.level} out of 5`}>{Array.from({ length: 5 }, (_, i) => <i key={i} className={i < s.level ? "filled" : ""} />)}</span>
  </div>)}</>;
}

/** The evaluation summary (reviewer and date, strengths, development priorities, readiness), or the empty state. */
export function EvaluationSummary({ review, headingLevel = "h3" }: { review: Employee["review"]; headingLevel?: "h3" | "h4" }) {
  if (!hasEvaluation(review)) return <p className="muted">{NO_EVALUATION}</p>;
  const Heading = headingLevel;
  return <>
    <small>{formatDisplayDate(review.date)} · {review.reviewer}</small>
    <Heading>Strengths</Heading>
    <p className="body-copy">{review.strengths}</p>
    <Heading>Development priorities</Heading>
    <p className="body-copy">{review.next}</p>
    <div className="callout">{review.readiness}</div>
  </>;
}
