# Spec NNN — <Feature Name>

**Status:** Draft | In Review | Approved | Implemented
**Owner:** <Responsible person or team>
**Dependencies:** <Related specs or "None">

## 1. Context and Objective
<What problem does this feature solve, why does it matter, and what outcome should it achieve? One paragraph.>

## 2. Users / Actors
<Who or what interacts with this feature? Human users, systems, services, or domain modules. Write "N/A" if not applicable.>

## 3. User Stories
- US-1: As a <role/actor>, I want <capability> so that <benefit>.

<For infrastructure features, describe system capabilities from the perspective of publishers, consumers, or developers.>

## 4. Functional Requirements (EARS)
- FR-1: WHEN <trigger>, THE SYSTEM SHALL <observable response>.
- FR-2: IF <unwanted condition>, THEN THE SYSTEM SHALL <required response>.
- FR-3: WHILE <state>, THE SYSTEM SHALL <required behavior>.
- FR-4: THE SYSTEM SHALL <always-required behavior>.

<Use only applicable EARS patterns. Each requirement must be specific, measurable, and testable.>

## 5. Non-Functional Requirements
<Only applicable constraints: security, performance, reliability, accessibility, compatibility, etc.>

- NFR-1: <Measurable constraint>.

## 6. Acceptance Scenarios
<Describe how the expected behavior will be verified. Reference requirement IDs.>

### AS-1: <Scenario name>
**Given** <initial state>
**When** <action or trigger>
**Then** <expected observable result>

**Covers:** FR-1

## 7. Edge Cases
- EC-1: <Boundary, duplicate, invalid input, concurrency, or failure condition and expected behavior>.

## 8. Out of Scope
- <Explicitly excluded functionality for this iteration>.

## 9. Definition of Done
- [ ] All functional requirements are implemented.
- [ ] All acceptance scenarios pass.
- [ ] Applicable edge cases are covered by tests.
- [ ] Non-functional requirements are verified.
- [ ] No unintended architectural boundary violations.
- [ ] Codex implementation reviewed by Claude Code.
- [ ] Final approval obtained.

## 10. Open Questions
- [NEEDS CLARIFICATION] <Question or unresolved decision>

<Use "None" when all decisions are resolved.>
