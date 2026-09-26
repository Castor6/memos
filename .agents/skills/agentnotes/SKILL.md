---
name: agentnotes
description: Capture agreed requirements, design decisions and their reasons, and implementation evidence as dated Markdown task notes. Use during substantive development work and requirement discussions, when continuing or handing off a task, or when reviewing past design decisions.
license: MIT
---

# AgentNotes

Leave enough context for a future reader to understand what was wanted, why a
decision was made, and what actually happened. Write concise notes in the
language requested by the user, otherwise follow the project's documentation
language. A discussion can produce a useful note before implementation begins.

## Project layout

Keep records at the repository root under `docs/tasks/`:

```text
docs/tasks/
├── TEMPLATE.md
├── INDEX.md
└── TASK-YYYYMMDD-short-topic.md
```

Use the task's creation date and a short, searchable topic in its filename.
Keep that filename stable when continuing the task. Choose a distinct topic
suffix if the filename is already used by unrelated work.

When setting up AgentNotes, create the directory and copy missing
[TEMPLATE.md](assets/TEMPLATE.md) and [INDEX.md](assets/INDEX.md) into it. Existing
files need no bulk rewrite. Setup does not require editing `AGENTS.md`. If the
user wants an explicit project-wide recording convention, the optional
[AGENTS.md entry](assets/AGENTS_SNIPPET.md) can be merged into the project's root
`AGENTS.md` without duplicating existing instructions.

## Capture or continue a task

- When first recording a task, create `docs/tasks/` and copy missing
  `TEMPLATE.md` and `INDEX.md` from the assets above before searching or writing.
- Record substantive requirements, meaningful design choices, investigations,
  and implementation outcomes. Related small fixes can share a note. Routine
  questions and trivial edits need no new record unless requested.
- If a task is named, open that file. Otherwise, search `docs/tasks/` by the
  feature, module, or relevant identifier before choosing a new filename. Read
  only directly relevant notes and necessary links.
- Continue the same task in its original file. Give independent work its own
  note and link related records. Record the responsible session or working branch
  in the note's header when creating it. One session owns a note at a time; on
  handoff, update that maintainer. Follow project rules for code and worktree
  coordination.
- Start with the background, goal, and concrete acceptance criteria. Distinguish
  user-confirmed requirements from suggestions and unresolved questions.
- Preserve important decisions **and their reasons**. Include rejected
  alternatives only when they explain a meaningful tradeoff. Do not invent a
  rationale that the conversation or evidence did not establish.
- Update at meaningful decisions, handoffs, or completion. When the scope
  changes, date the new decision and say which earlier assumption it replaces.
  Preserve earlier facts without presenting superseded choices as current.

Use `docs/tasks/TEMPLATE.md` as the writing guide. Omit sections that do not
apply; do not fill them with repetitive placeholders. A discussion-only record
should say implementation and verification have not happened, rather than
pretending they are complete.

## Record outcomes and evidence

Record actual behavior and relevant files, then describe verification with its
date, code revision or identifiable workspace baseline, method, result, and
useful evidence links. State failures, checks not run, and remaining limitations.
Checked acceptance criteria mean evidence was obtained for that work; they do
not imply later CI, merge, publication, or deployment.

Keep notes as dated facts. Do not maintain live fields such as "waiting for CI",
"awaiting merge", or "not deployed", and do not add a new documentation commit
each time external progress changes. A dated release or deployment observation
may be recorded when relevant and supported by evidence. Follow PR, CI, release,
or private operations links when current status is needed.

Keep raw conversations, full logs, screenshots, credentials, user data, and
runtime artifacts out of task notes. Summarize useful evidence and link to an
appropriate location without exposing private data. Do not copy commit or push
logs. Follow-up suggestions are not promises of automatic future work.

If a conclusion should govern future work, put the concise current rule in the
relevant module documentation or `AGENTS.md` and link the originating task.
Keep the historical explanation in the task. Do not elevate one-off preferences
or unconfirmed ideas into permanent project rules.

## Recall a past decision

For a recall-only request, read without creating or updating records, templates,
or repository instructions. If `docs/tasks/` is absent, report that no AgentNotes
records were found there; do not initialize the layout just to answer a question.

Search filenames, titles, module keywords, and relevant identifiers; broaden the
wording when a first search misses. The copied `docs/tasks/INDEX.md` contains
example commands. It is a fixed search guide, not a task catalog; adding a task
does not require editing it. Do not read every historical note at startup.

Answer from the relevant dated discussion, decisions, and evidence. Distinguish
what the record establishes from your inference. When asked about current
behavior, compare the historical note with current code or the appropriate
external source. If a reason was never recorded, say so. A historical pass is
not proof that today's code passes.

When finishing a note, check that its links resolve and that the text answers
the useful questions for this task: what was wanted, why it was chosen, what
was done, and what remains unknown. Report the note's path to the user.
