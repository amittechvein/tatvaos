# A CI job stuck "in progress"

**Rule (Mr. Singh, 1 October 2026):** a CI job "in progress" for longer than
**three times its usual run** is stuck, not slow. Force-cancel it and re-run.
Don't wait for GitHub's six-hour limit.

**Symptom.** One job of a run stays "in progress" while the others have long
finished. For example, PR 369's run on 1 Oct 2026: *Tenant isolation* (about
3 minutes normally) was still "in progress" 2 h 40 min after it started. The
PR could not be called green, and nothing else was wrong.

**Diagnosis.** Compare the job's start time with its usual length:

```bash
GH_TOKEN="$(gh auth token --user amittechvein)" gh run view <run-id> --repo amittechvein/tatvaos --json jobs --jq '.jobs[] | "\(.name): \(.status) started \(.startedAt)"'
```

More than three times the usual run means stuck. You can still read the jobs that did finish while the run "runs":

```bash
GH_TOKEN="$(gh auth token --user amittechvein)" gh api --allow-escape-sequences repos/amittechvein/tatvaos/actions/jobs/<job-id>/logs
```

`gh run view --log` refuses until the whole run completes.

**Fix.** An ordinary cancel may not reach a stuck runner. Force-cancel, wait for "completed", then re-run only what didn't pass:

```bash
GH_TOKEN="$(gh auth token --user amittechvein)" gh api -X POST repos/amittechvein/tatvaos/actions/runs/<run-id>/force-cancel
```

```bash
GH_TOKEN="$(gh auth token --user amittechvein)" gh run rerun <run-id> --repo amittechvein/tatvaos --failed
```

**Confirm.** The run's attempt number goes up, the re-run job finishes in its usual time, and the run's other jobs keep their results. On 1 Oct 2026, attempt 2 of PR 369's run finished *Tenant isolation* green in its normal few minutes.
