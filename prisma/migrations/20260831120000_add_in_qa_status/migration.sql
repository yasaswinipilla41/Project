-- Adds "In QA" to IssueStatus: work that has been picked up for testing, as
-- distinct from IN_REVIEW ("Ready for QA"), which is work merely handed over.
--
-- Purely additive. No table is altered, no column is dropped or renamed, and
-- no existing row is rewritten — every issue keeps the status it already has.
--
-- Declared AFTER 'IN_REVIEW' rather than appended, because Postgres sorts an
-- enum by declaration order and `ORDER BY status` is used for the issue list's
-- status sort; appending would have placed "In QA" after "Cancelled".
ALTER TYPE "IssueStatus" ADD VALUE 'IN_QA' AFTER 'IN_REVIEW';
