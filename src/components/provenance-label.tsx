import type { Assignment, BackfilledProject } from "@/data/employees";

/**
 * Story 4.7: the text marker of a history row's origin, read from its materialized `provenance` (never
 * inferred from the list it came from): "Manager-created" for an assignment, "Self-reported" for a past
 * project the employee added. Text as well as colour.
 */
export default function ProvenanceLabel({ provenance }: { provenance: Assignment["provenance"] | BackfilledProject["provenance"] }) {
  return provenance === "backfilled"
    ? <span className="badge amber"><span className="dot" />Self-reported</span>
    : <span className="badge blue"><span className="dot" />Manager-created</span>;
}
