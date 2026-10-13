# Release lifecycle evidence (isolated in-memory store)

Real publisher, real Business Pack repository and loader, real checksum-bound activation repository, the real four-hop public path. The store is in memory; nothing here touches a real environment.

| Step | Action | Expected | Observed |
|---|---|---|---|
| 1 | approve v1.0.3 (migrated) and chat | customer served by v1 | served; conversation pinned to 25f986c925f1… |
| 2 | publish v1.0.4 | record follows by checksum; new conversations on v2; the old one stays on v1 | record → 32710664563f…; new pinned to v2; old still pinned to v1 |
| 3 | try four wrong approvals of v2 | each refused; the record is unchanged | CHECKSUM_MISMATCH, ReleaseActivationConflictError, POINTER_VERSION_MISMATCH, RELEASE_NOT_FOUND |
| 4 | approve v2 as a canary: 0%, then 100% | refused at 0%, served at 100% | 0%: HTTP 500 with a plain refusal; 100%: served |
| 5 | roll back to v1 | record and traffic return to v1, by its original checksum | record → 25f986c925f1…; a new conversation pinned to v1 |
| 6 | set the activation to rollback, then re-approve v1 | all traffic stops; then resumes | refused for new and pinned conversations; served after the approval |
| 7 | read the record | attributed, checksum-bound, monotonic revision | revision 8, approved by human:release-manager |
| 8 | stop the line, publish, roll back, then approve v1 | a publish and a rollback leave the line stopped; the explicit approval restores it | status stayed rollback and nobody was served until the approval |
