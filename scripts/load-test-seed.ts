import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Generates bulk issues to check §39's target of roughly 2,000 issues per
 * project. Development only — it creates a throwaway project, and
 * `--cleanup` removes it again.
 *
 *   npx tsx scripts/load-test-seed.ts            # create
 *   npx tsx scripts/load-test-seed.ts --cleanup  # remove
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const PROJECT_KEY = "LOAD";
const TARGET = 2_000;

const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
] as const;
const PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR", "TRIVIAL"] as const;
const TYPES = ["TASK", "BUG", "STORY"] as const;

async function cleanup() {
  const project = await prisma.project.findUnique({
    where: { key: PROJECT_KEY },
    select: { id: true },
  });
  if (!project) {
    console.log("Nothing to clean up.");
    return;
  }
  await prisma.project.delete({ where: { id: project.id } });
  console.log(`Removed the ${PROJECT_KEY} project and its issues.`);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }

  const users = await prisma.user.findMany({
    select: { id: true },
    orderBy: { email: "asc" },
  });
  if (users.length === 0) throw new Error("Seed the database first.");

  await cleanup();

  const project = await prisma.project.create({
    data: {
      key: PROJECT_KEY,
      name: "Load Test",
      description: `Generated project holding ${TARGET} issues for performance checks.`,
      createdById: users[0]!.id,
      members: { createMany: { data: users.map((u) => ({ userId: u.id })) } },
    },
    select: { id: true },
  });

  const started = Date.now();

  // One createMany rather than 2,000 round trips.
  const rows = Array.from({ length: TARGET }, (_, i) => {
    const n = i + 1;
    const type = TYPES[i % TYPES.length]!;
    const isBug = type === "BUG";
    const assignee = users[i % users.length]!;

    return {
      key: `${PROJECT_KEY}-${n}`,
      number: n,
      projectId: project.id,
      type,
      title: `Generated ${type.toLowerCase()} ${n} for load testing`,
      description: `Synthetic issue ${n}.`,
      status: STATUSES[i % STATUSES.length]!,
      priority: PRIORITIES[i % PRIORITIES.length]!,
      severity: isBug ? SEVERITIES[i % SEVERITIES.length]! : null,
      stepsToReproduce: isBug ? `1. Step one\n2. Step two (${n})` : null,
      expectedResult: isBug ? "It works" : null,
      actualResult: isBug ? "It does not" : null,
      environment: isBug ? (i % 2 === 0 ? "Production" : "Staging") : null,
      assigneeId: i % 7 === 0 ? null : assignee.id,
      reporterId: users[(i + 1) % users.length]!.id,
      sortIndex: n * 100,
      dueDate: i % 5 === 0 ? new Date(Date.now() + (i % 30) * 86_400_000) : null,
    };
  });

  await prisma.issue.createMany({ data: rows });
  await prisma.project.update({
    where: { id: project.id },
    data: { issueSequence: TARGET },
  });

  console.log(
    `Created ${TARGET} issues in ${PROJECT_KEY} in ${Date.now() - started}ms`,
  );
  console.log("Remove them with: npx tsx scripts/load-test-seed.ts --cleanup");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
