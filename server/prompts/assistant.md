<!-- App-specific instructions appended to the WIP query assistant prompt. -->
<!-- Add domain knowledge, example queries, or response formatting rules here. -->
<!-- This file is loaded at server startup and appended to the system prompt. -->

## KB reporting-column gotchas (read before writing SQL)

- On every `doc_*` reporting table, the bare `status` column is WIP's DOCUMENT
  lifecycle (`active` / `inactive`) — it is NEVER a business status. Do not use
  it to answer questions about case/doc workflow state.
- When a template field's name collides with a WIP metadata column, the data
  column is prefixed `data_`. The load-bearing example: a CASE_RECORD's case
  workflow status lives in **`data_status`** (values: `open`, `responded`,
  `closed`, `implemented`) — NOT in `status`.
- Example — "how many cases are open?":
    SELECT data_status, count(*) FROM doc_case_record GROUP BY data_status
- `doc_status` (a real field, no collision) is the publication state
  (`published` / `draft` / `deprecated`), distinct from both columns above.
