# Task search

Task records are independent Markdown files. This page contains fixed search
instructions, not a task list. Adding or continuing a task does not require
updating this file.

Run from the repository root:

```bash
# Locate task files.
rg --files docs/tasks -g 'TASK-*.md'

# Locate a known task or topic; replace the example with the relevant name.
rg --files docs/tasks -g '*export-preview*'

# Find relevant files by title, module, or body text; choose task-specific terms.
rg -li 'export|preview' docs/tasks -g 'TASK-*.md'

# Inspect matching lines without loading the whole history.
rg -ni 'decision|reason|verification' docs/tasks -g '*export-preview*'
```

Use the language and identifiers found in the project. Try related terms when
a search returns no useful results. Open only relevant notes and necessary
links; a first search miss does not establish that no prior decision exists.

New notes use [the template](TEMPLATE.md) and the stable filename
`TASK-YYYYMMDD-short-topic.md`. Make titles and module keywords searchable.
One session maintains a note; independent work gets a separate linked note,
and an explicit handoff may continue the original file.

A note records dated facts. Check the relevant current source when asked about
today's code, CI, release, or deployment. Do not commit a generated task catalog.
