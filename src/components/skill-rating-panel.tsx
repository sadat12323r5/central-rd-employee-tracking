"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { SKILL_EVIDENCE_MAX, SKILL_LEVEL_LABELS, SKILL_LEVELS, SKILL_NAME_MAX } from "@/domain/assessment-input";
import type { ActionState } from "@/server/attendance-actions";
import { rateSkillAction } from "@/server/assessment-actions";

const initial: ActionState = { error: "", message: "" };

/**
 * Story 7.4: the Administrator (anyone) and department managers (their subtree) rate one of an employee's
 * skills 1–5 with supporting evidence. Typing an existing skill's name (any case) re-rates it; the list of
 * existing names is offered as suggestions. The server re-checks everything. Render it with
 * `key={employeeId}`; the form inside is keyed by the current skills, so it clears once a save has
 * refreshed them, while the confirmation (held by this component) stays.
 */
export default function SkillRatingPanel({ employeeId, name, skills }: {
  employeeId: string; name: string; skills: { name: string; level: number; evidence: string }[];
}) {
  const [state, action, pending] = useActionState(rateSkillAction, initial);
  // Submitted by hand rather than through `action=`, which would make React reset the form after every
  // submission: a refusal keeps what was entered (and focus).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  const prefix = `skill-${employeeId}`;
  const current = skills.map(s => `${s.name}\u0000${s.level}\u0000${s.evidence}`).join("\u0001");
  return <article className="panel assessment-form" aria-labelledby={`${prefix}-heading`}>
    <h2 id={`${prefix}-heading`}>Rate a skill</h2>
    <p className="muted">Add a skill for {name}, or enter an existing one to re-rate it. Every field is required.</p>
    <form key={current} onSubmit={onSubmit} className="staff-log" aria-label="Rate a skill">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="add-employee-grid">
        <div className="staff-field">
          <label htmlFor={`${prefix}-name`}>Skill</label>
          <input id={`${prefix}-name`} name="name" type="text" list={`${prefix}-names`} required maxLength={SKILL_NAME_MAX} autoComplete="off" />
          <datalist id={`${prefix}-names`}>{skills.map(s => <option key={s.name} value={s.name} />)}</datalist>
        </div>
        <div className="staff-field">
          <label htmlFor={`${prefix}-level`}>Level</label>
          <select id={`${prefix}-level`} name="level" defaultValue="" required>
            <option value="" disabled>Choose a level</option>
            {SKILL_LEVELS.map(level => <option key={level} value={level}>{level} · {SKILL_LEVEL_LABELS[level]}</option>)}
          </select>
        </div>
      </div>
      <div className="staff-field">
        <label htmlFor={`${prefix}-evidence`}>Evidence</label>
        <textarea id={`${prefix}-evidence`} name="evidence" rows={2} required maxLength={SKILL_EVIDENCE_MAX} />
      </div>
      <div className="staff-actions">
        <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save rating"}</button>
      </div>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
    </form>
    <p role="status" className="staff-status">{state.error ? "" : state.message}</p>
  </article>;
}
