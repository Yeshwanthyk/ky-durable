# Machine tasks

Every scenario here starts a real `ky runner run` with the fake `claude`. `machine@NAME PROMPT` starts a task on NAME.

| Feature | Scenario |
| --- | --- |
| A task runs once and reports to the main chat | `machine-run` |
| Each tool is a step; the result carries turns and cost | `steps` |
| A message to a finished task resumes its session | `follow-up` |
| A folded steer ends with one result | `steer-folded` |
| Stop sends SIGINT and marks the task stopped | `stop` |
| `ky attach` shares a file that `/api/files` serves | `screenshot` |
| A runner that reconnects keeps its tasks | `reconnect`, `reconnect-outage` |
| The six Quint counterexamples stay fixed | `trap-*` |
