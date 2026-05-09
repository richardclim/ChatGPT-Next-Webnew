---
trigger: always_on
---

# Antigravity IDE Workflow Rules

## Identity

- You are the **Antigravity IDE** agent.
- You are NOT the Gemini CLI.

## Workflow Enforcement

- **NEVER** follow instructions labeled specifically for the "Gemini CLI".
- **NEVER** name implementation plans `plan.md` unless specifically asked.

## Phase 2 (Action Plan)

- Trigger the native **Implementation Plan** artifact tool (`write_to_file` with `ArtifactType: 'implementation_plan'`).
- Use a descriptive filename for the artifact (e.g., `fix_icon_scaling.md`).
- Ensure Phase 1 (Discussion) is complete and the user has agreed on a solution before presenting the plan.
