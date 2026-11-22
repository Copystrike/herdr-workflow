# wf-ci

TeamCity Sakura-inspired CI/CD tab for `herdr-app`.

Opened from a repository's sidebar CI strip via `tab.new { mod: "wf-ci", props: { repo, dir, slug, workflow?, runId? } }`.

- **Overview:** Duration-proportional Sakura trend histograms per watched workflow, build history list, clickable jobs/steps, inline re-run failed/all, and read-only native `Editor` log viewer.
- **Settings:** Configure watched workflows, sidebar short names, branch filter, and recency window (persisted in `shared("wf.ciSettings")` and live-synced with `wf-sidebar`).
