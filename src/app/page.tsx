const modules = [
  ["People", "Employment history, role families, experience, and validated skills"],
  ["Development", "Training, assessments, certifications, and growth plans"],
  ["Readiness", "Availability, capacity, job fit, and evidence-backed evaluation"],
  ["Assignments", "Internal and client projects with effective-dated allocation"],
  ["Opportunities", "Client submissions, interview rounds, outcomes, and follow-up"],
];

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Central R&amp;D · Internal portal</p>
        <h1 id="page-title">Develop talent. Find the right fit. Preserve the evidence.</h1>
        <p className="summary">
          One governed view of employee growth, training, readiness, allocation,
          client interviews, attendance, and work history.
        </p>
        <div className="status" role="status">
          <span aria-hidden="true" /> MVP foundation in progress
        </div>
      </section>

      <section className="modules" aria-labelledby="modules-title">
        <div className="section-heading">
          <p className="eyebrow">Resource lifecycle</p>
          <h2 id="modules-title">Five connected views of growth</h2>
        </div>
        <div className="grid">
          {modules.map(([name, description], index) => (
            <article key={name}>
              <span className="number">0{index + 1}</span>
              <h3>{name}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
