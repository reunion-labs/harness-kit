import { printSkill } from "../skill";

const SKILL_REL = "skills/harness-check-loop/SKILL.md";

const META = `<!-- harness-kit check-loop -->
You are an AI agent implementing a requirement or fixing a bug in the CURRENT repo.
Follow the loop below. Run every harness-kit command through the pinned
\`npx -y @erzhe/harness-kit@<version from .agents/harness.lock.json> <cmd>\`
(the "Harness CLI" line in AGENTS.md; \`@latest\` only without a lock) unless a
local build is available. A bare \`harness-kit\` is usually not on PATH.
Primary finish gate: \`deliver\` (scope → run-checks + verify → stamp).
Optional Stop hooks only check that stamp; they must not demand a new session.
Use \`evidence\` to inspect the durable stamp.

---

`;

export function checkLoopCmd(): number {
  return printSkill(SKILL_REL, META);
}
