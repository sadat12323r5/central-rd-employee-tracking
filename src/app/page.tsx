const modules = [
  ["Profiles", "Provisioned identities and role-controlled employee records"],
  ["Leave", "Inclusive working-day records with versioned calendars"],
  ["GitHub activity", "Signed, allowlisted push metadata without source code"],
  ["Assignments", "Trainee and Senior Researcher working relationships"],
  ["Logbooks", "Plain-text blockers, solutions, and milestones"],
];

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Central R&amp;D · Internal portal</p>
        <h1 id="page-title">Employee tracking without the surveillance theatre.</h1>
        <p className="summary">
          A focused operational record for people, leave, recorded GitHub activity,
          trainee assignments, and engineering logbooks.
        </p>
        <div className="status" role="status">
          <span aria-hidden="true" /> MVP foundation in progress
        </div>
      </section>

      <section className="modules" aria-labelledby="modules-title">
        <div className="section-heading">
          <p className="eyebrow">30-working-day scope</p>
          <h2 id="modules-title">Five deliberately small modules</h2>
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
