# Optional site workflow template

Prefer putting this guidance in the site's SDK `instructions` so every page ships its own guide. Copy this into a separate site-specific skill only when the site cannot provide `instructions` and its tool descriptions do not adequately explain its workflow. This file is an authoring template, not executable task instructions.

Document:
- Site origins and the business goal this workflow serves.
- User inputs needed before starting; where real object IDs are obtained.
- The query / preparation / submission / verification sequence.
- Which returned status establishes success and how to reconcile an unknown result.
- Site-specific terminology and constraints that are not already expressed by tool schemas.

Do not copy volatile tool catalogs, hard-code credentials or document IDs, or authorize actions beyond the user's request. Keep the general BrowserSkill skill unchanged when adding business guidance.
