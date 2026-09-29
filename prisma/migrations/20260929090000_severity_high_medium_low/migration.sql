-- Severity: CRITICAL/MAJOR/MINOR/TRIVIAL  ->  HIGH/MEDIUM/LOW
--
-- Mapping (approved):
--   CRITICAL -> HIGH    MAJOR -> HIGH    MINOR -> MEDIUM    TRIVIAL -> LOW
--   NULL stays NULL (severity is optional).
--
-- Nothing that was serious is downgraded. The column stays nullable and has no
-- default. Only "issue"."severity" (and its index) is touched.
--
-- Safe to run twice: a value that is already HIGH/MEDIUM/LOW falls through to
-- the ELSE branch unchanged, and NULL stays NULL. A value can only ever move from
-- the old scale to the new one, never along the new one.
--
-- ROLLBACK: restore the pre-migration backup. The mapping cannot be reversed
-- (CRITICAL and MAJOR both became HIGH).
--
-- ActivityLogEntry is append-only and is NOT rewritten: old "MAJOR" text is
-- translated when displayed (LEGACY_SEVERITY in src/lib/domain.ts).

BEGIN;

CREATE TYPE "Severity_new" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

ALTER TABLE "issue"
  ALTER COLUMN "severity" TYPE "Severity_new"
  USING (
    CASE "severity"::text
      WHEN 'CRITICAL' THEN 'HIGH'
      WHEN 'MAJOR'    THEN 'HIGH'
      WHEN 'MINOR'    THEN 'MEDIUM'
      WHEN 'TRIVIAL'  THEN 'LOW'
      ELSE "severity"::text
    END
  )::"Severity_new";

ALTER TYPE "Severity" RENAME TO "Severity_old";
ALTER TYPE "Severity_new" RENAME TO "Severity";
DROP TYPE "Severity_old";

COMMIT;
