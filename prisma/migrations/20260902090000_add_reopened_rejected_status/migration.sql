-- Adds REOPENED and REJECTED to IssueStatus.
--
-- REOPENED  — work that was finished and has come back. Distinct from
--             IN_PROGRESS: it records that the issue was once closed, which is
--             the thing a reopen is worth reporting on.
-- REJECTED  — displayed as "Rejected / Not an Issue". A closing status, like
--             CANCELLED, but for a different reason: cancelled work was real
--             and then dropped; rejected work was never work.
--
-- Purely additive. No table is altered, no column is dropped or renamed, and
-- no existing row is rewritten — every issue keeps the status it already has.
--
-- Positions are declared rather than appended, because Postgres sorts an enum
-- by declaration order and `ORDER BY status` drives the issue list's status
-- sort. REOPENED sits after DONE (it is what follows being done) and REJECTED
-- after it, keeping the closing statuses beside one another.
ALTER TYPE "IssueStatus" ADD VALUE 'REOPENED' AFTER 'DONE';
ALTER TYPE "IssueStatus" ADD VALUE 'REJECTED' AFTER 'REOPENED';
