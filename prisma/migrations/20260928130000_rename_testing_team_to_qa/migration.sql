-- The team called "Testing" is now called "QA Team".
--
-- Display name only. The slug ('testing') is the stable key every authorization
-- check in the application reads — it is never shown and is NOT touched here,
-- nor is the row's id, its description or its membership. Nobody gains or loses
-- access; the team is the same team under a new label.
--
-- Guarded twice so it can never do more than that:
--   * it only renames a row still called exactly 'Testing', so a team an
--     administrator has already renamed by hand is left as they chose;
--   * it is skipped if some other team already holds the name 'QA Team',
--     because "team"."name" is unique and a clash would abort the migration.
--
-- Stored notification text ("... as tester for ...", "... to test ...") is
-- history and is deliberately left as it was written.
--
-- ROLLBACK: UPDATE "team" SET "name" = 'Testing' WHERE "slug" = 'testing';

UPDATE "team"
SET "name" = 'QA Team',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'testing'
  AND "name" = 'Testing'
  AND NOT EXISTS (SELECT 1 FROM "team" WHERE "name" = 'QA Team');

-- The Full Stack team's stored description names the old team. Rewritten only
-- where it is still exactly the text this application wrote, so a description an
-- administrator edited by hand is never overwritten.
--
-- ROLLBACK: restore from backup, or set it back to the text in the WHERE clause.
UPDATE "team"
SET "description" = 'Builds and verifies. A membership of its own — holding it changes nothing about Development or QA.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'fullstack'
  AND "description" = 'Builds and verifies. A membership of its own — holding it changes nothing about Development or Testing.';
