-- The Development team: a roster, not a role.
--
-- Prio derives the working role from the Testing team and always has:
--
--     ADMIN                           -> Admin
--     MEMBER on Testing               -> QA member
--     MEMBER not on Testing           -> Developer
--
-- Developer is therefore the *absence* of Testing membership, which left
-- Administration with nothing to list: there was no row anywhere saying who
-- the developers are. This inserts one team so there is something to manage,
-- exactly as `add_teams` anticipated -- "Development, Design and the rest are
-- inserts, not another authorization branch".
--
-- It is a roster and nothing more. `workRoleOf` does not read it, no
-- permission is granted or withheld by it, and somebody on both teams is a QA
-- member because Testing still decides that. Membership here records who an
-- administrator has deliberately onboarded as a developer, so the block has a
-- list and each person has somewhere to hang a profile.
--
-- Entirely additive:
--   * one new row
--   * no table created, altered or dropped
--   * no existing row read, rewritten or deleted
--
-- The team starts empty. Putting people in it is a deliberate act performed
-- through the app, never by a migration.

INSERT INTO "team" ("id", "slug", "name", "description", "createdAt", "updatedAt")
VALUES (
    'team_development_000000000000',
    'development',
    'Development',
    'Builds what has been raised, and hands it back for QA.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;
