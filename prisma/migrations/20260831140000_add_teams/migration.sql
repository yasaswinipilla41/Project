-- Teams: a named group of people, and explicit membership of it.
--
-- Prio had two roles and no way to say what somebody does, so anything that
-- needed "the testing team" had to invent it. This makes a team a row rather
-- than a code path: "Development", "Design" and the rest are inserts, not
-- another authorization branch.
--
-- Entirely additive:
--   * two new tables
--   * no existing table altered
--   * no column dropped, renamed or retyped
--   * no existing row read, rewritten or deleted
--
-- Nobody is a member of anything when this runs. Membership is only ever
-- created explicitly, so no existing user gains or loses any access here.

CREATE TABLE "team" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_slug_key" ON "team"("slug");
CREATE UNIQUE INDEX "team_name_key" ON "team"("name");

CREATE TABLE "team_member" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_member_teamId_userId_key" ON "team_member"("teamId", "userId");
CREATE INDEX "team_member_userId_idx" ON "team_member"("userId");

ALTER TABLE "team_member" ADD CONSTRAINT "team_member_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Testing team itself, with no members. Seeding people into it is a
-- deliberate act performed through the app, never by a migration.
INSERT INTO "team" ("id", "slug", "name", "description", "createdAt", "updatedAt")
VALUES (
    'team_testing_0000000000000000',
    'testing',
    'Testing',
    'Quality assurance and verification.',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
