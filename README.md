# Software Requirements Specification (SRS)
## Project: Central R&D Employee Tracking System (30-Day MVP)

### 1. Introduction
#### 1.1 Purpose
This document specifies the core functional, non-functional, and quality assurance requirements for the Minimum Viable Product (MVP) of the Central R&D Employee Tracking System. The goal of this system is to consolidate internal engineering profiles, Learning & Development (L&D) metrics, duration-dependent leave visualizations, basic automated Git tracking, and chronological trainee logbooks into a single, high-reliability platform.

#### 1.2 Scope
The scope of this 30-working-day development window is strictly constrained to establishing a reliable backend data model, building dynamic duration color flags, mapping incoming webhook event streams, and implementing rock-solid test coverage. 

*   **In-Scope:** Simple profile administration, manual leave entry form, dynamic color engine, Git commit ingestion via webhook, plain-text trainee logbooks, and 100% test coverage for critical business logic modules.
*   **Out-of-Scope (Post-MVP):** Automated multi-tier approval chains, direct OAuth provisioning/removal of repository permissions, rich media/file attachments inside logbooks, and AI-driven skill-gap analyses.

#### 1.3 Definitions & Acronyms
*   **L&D:** Learning and Development.
*   **MVP:** Minimum Viable Product.
*   **RBAC:** Role-Based Access Control.
*   **RLS:** Row-Level Security.
*   **QA:** Quality Assurance.

---

### 2. Overall Description
#### 2.1 Product Perspective
The system operates as a secure internal micro-portal. It relies on real-time asynchronous webhook calls from external code-hosting providers (e.g., GitHub, GitLab) to log engineering cadence data without archiving source code content or exposing proprietary software repositories.

#### 2.2 User Classes and Access Permissions
*   **R&D Manager / Administrator:** Full global Read/Write access across all system tables, profiles, tracking systems, leaves, and trainee logbooks.
*   **Standard Researcher / Trainee:** Full Read access to their personal profile/metrics; Write access strictly restricted to their own leave logs and chronological developer logbooks.

---

### 3. Functional Requirements

#### 3.1 Central R&D Profile & L&D Management
*   **FR-3.1.1:** The system must record and update core employee information including Name, Unique ID, Engineering Competency Matrix, Training Accomplishments, and Career Milestone Histories.
*   **FR-3.1.2:** The system must restrict record visibility at the API and database levels using Role-Based Access Control (RBAC).

#### 3.2 Leave Logging & Duration Color Engine
*   **FR-3.2.1:** The system must accept calendar entries (Start Date, End Date) and compute the exact net working day delta.
*   **FR-3.2.2:** The application must return a distinct visual hex flag matching the following strict duration thresholds to ensure visual dashboard scannability:
    *   `1 – 3 Working Days`: Green (`#22C55E`) — Micro-allocation / Short Leave
    *   `4 – 14 Working Days`: Blue (`#3B82F6`) — Sprint Cycles / Standard Leave
    *   `15 – 30 Working Days`: Yellow (`#EAB308`) — Mid-term Rotations / Medical Leave
    *   `31 – 90 Working Days`: Orange (`#F97316`) — Extended Trainee Allocations
    *   `91+ Working Days`: Red/Purple (`#A855F7`) — Long-term Sabbatical / Reassignment

#### 3.3 Git Metadata & Access History Log
*   **FR-3.3.1:** The system must expose a secure public endpoint capable of parsing standardized JSON commit payloads from version control providers.
*   **FR-3.3.2:** Incoming Git telemetry strings (Author Email, Target Repository, Commit Timestamp) must be automatically indexed and linked to the respective developer profile using the matching email string.

#### 3.4 Trainee Allocation History & Logbooks
*   **FR-3.4.1:** The platform must store chronological placement trails documenting which trainee is assigned to which Senior Researcher, project workspace, and date range.
*   **FR-3.4.2:** Trainees must have a plain-text module to submit daily developer journals logging technical blocks encountered, solutions tried, and milestones cleared.

---

### 4. Non-Functional & Quality Assurance Requirements

#### 4.1 Testability & Code Quality Mandate (Day 30 Gate)
*   **QA-4.1.1 (Unit Testing):** The date calculation logic and the color boundary engine must maintain **100% automated unit test coverage** before deployment to production.
*   **QA-4.1.2 (Security Testing):** Security verification tests must explicitly assert that data tables running Row-Level Security (RLS) reject cross-tenant manipulation requests (e.g., verifying a trainee cannot access or edit another employee's profile records).
*   **QA-4.1.3 (Integration Testing):** The Git webhook receiver module must pass error-resiliency integration tests using mocked invalid payloads to confirm the API gracefully logs failures without dropping the service database connection.

#### 4.2 Security & Data Privacy
*   **SEC-4.2.1:** All data packages in transit must be encrypted strictly using HTTPS/TLS protocols.
*   **SEC-4.2.2:** External repo configurations, service access tokens, or identifiers stored in the primary datastore must be fully encrypted at rest.

---

### 5. Post-MVP Scope Target List (Day 31+)
*   Dynamic, multi-tiered email approval routing workflows for leave requests.
*   Direct execution scripts for automated provisioning or deprecation of repository permissions via provider APIs.
*   Rich text rendering, document uploads, and automated summary generators for Trainee daily logs.
