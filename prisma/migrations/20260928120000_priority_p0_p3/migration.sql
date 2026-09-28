-- Priority: URGENT/HIGH/MEDIUM/LOW/NONE  ->  P0/P1/P2/P3
--
-- Mapping (approved):
--   URGENT -> P0      HIGH -> P1      MEDIUM -> P2      LOW -> P3      NONE -> P3
--
-- Nothing is ever assigned P0 except work that was already URGENT: an existing
-- HIGH, MEDIUM or LOW never becomes P0. The column stays NOT NULL; the default
-- moves from MEDIUM to P2, the row-for-row equivalent.
--
-- Not repeatable by construction. The column is retyped through a *new* enum
-- that does not contain the old words, so the mapping below can only ever read
-- old values. Run against a database that is already on P0..P3 the CASE has no
-- branch for them, yields NULL, and the NOT NULL constraint aborts the whole
-- statement — the transaction rolls back and nothing changes. Values can never
-- be shifted P1 -> P2 -> P3 by running this twice.
--
-- Only "issue"."priority" (and its index and default) is touched. No other
-- column, table or row is read or written.
--
-- ROLLBACK: do not reverse the mapping by hand. LOW and NONE both became P3, so
-- P3 cannot be told apart afterwards, and any P1/P2/P3 set by a person after
-- this ran is indistinguishable from a converted one. Restore the pre-migration
-- backup instead (scripts/backup/restore.sh) — take one first.
--
-- ActivityLogEntry is append-only and is NOT rewritten: its old "HIGH" / "URGENT"
-- text is translated when it is displayed (LEGACY_PRIORITY in src/lib/domain.ts).

BEGIN;

CREATE TYPE "Priority_new" AS ENUM ('P0', 'P1', 'P2', 'P3');

ALTER TABLE "issue" ALTER COLUMN "priority" DROP DEFAULT;

ALTER TABLE "issue"
  ALTER COLUMN "priority" TYPE "Priority_new"
  USING (
    CASE "priority"::text
      WHEN 'URGENT' THEN 'P0'
      WHEN 'HIGH'   THEN 'P1'
      WHEN 'MEDIUM' THEN 'P2'
      WHEN 'LOW'    THEN 'P3'
      WHEN 'NONE'   THEN 'P3'
    END
  )::"Priority_new";

ALTER TYPE "Priority" RENAME TO "Priority_old";
ALTER TYPE "Priority_new" RENAME TO "Priority";
DROP TYPE "Priority_old";

ALTER TABLE "issue" ALTER COLUMN "priority" SET DEFAULT 'P2';

COMMIT;
