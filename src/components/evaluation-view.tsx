import type { AssignmentEvaluation } from "@/data/employees";
import { authorshipText } from "@/domain/evaluations";

// Story 4.6: an assignment evaluation, read-only: the evaluation, the client's feedback (relayed by the
// manager) and who wrote (and last amended) it. Shared by the management portal's assignment history and
// the staff portal's "My assignments". Never a form control.

export default function EvaluationView({ evaluation, projectName }: {
  evaluation: AssignmentEvaluation | undefined;
  /** The assignment's project, so each evaluation region in a history has its own accessible name. */
  projectName: string;
}) {
  if (!evaluation) return <p className="muted evaluation-none">Not evaluated yet.</p>;
  return <section className="evaluation" aria-label={`Evaluation of ${projectName}`}>
    <h4>Evaluation</h4>
    <p className="evaluation-text">{evaluation.evaluation}</p>
    <h4>Client feedback</h4>
    <p className="evaluation-text">{evaluation.clientFeedback || "No client feedback recorded."}</p>
    <small className="evaluation-authorship">{authorshipText(evaluation)}</small>
  </section>;
}
