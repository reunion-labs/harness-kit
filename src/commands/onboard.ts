import pkg from "../../package.json";
import { harnessInvocation } from "../harness-cli";
import { printSkill } from "../skill";

const SKILL_REL = "skills/erzhe-harness-init/SKILL.md";

// The entry may be `@latest`, but everything after it must stay on the one
// version that printed these instructions: `init` writes it into
// .agents/harness.lock.json, and generated entries pin that lock version.
const META = `<!-- harness-kit onboard -->
You are an AI agent onboarding the CURRENT repository to harness-kit.
Follow the skill below verbatim. Run every harness-kit command through
\`${harnessInvocation(pkg.version)} <cmd>\` — the exact version printing this skill,
no global install. \`init\` records it in .agents/harness.lock.json. If the repository
already has that lock, use the version it pins instead and never mix versions.
Do not fabricate: confirm uncertain fields with the user, and report honest GAPS.

---

`;

export function onboardCmd(): number {
  return printSkill(SKILL_REL, META);
}
