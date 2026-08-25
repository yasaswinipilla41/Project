import { z } from "zod";
import { ISSUE_STATUSES, ISSUE_TYPES, PRIORITIES, SEVERITIES } from "@/lib/domain";

/**
 * Input contracts for every write path.
 *
 * Server actions validate through these before touching the database — the
 * browser form is a convenience, never the boundary. Bug-specific requirements
 * (§9) are enforced here with a discriminated refinement rather than in the UI.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/*
 * Create and update use *separate* field builders, deliberately.
 *
 * On create, an omitted field means "no value" and is stored as null. On
 * update, an omitted field means "leave this alone" and must survive parsing as
 * `undefined`. Deriving the update schema from the create one made every
 * partial update carry the create defaults, so changing a bug's priority
 * silently cleared its severity. The two are kept apart so that cannot recur.
 */

/** Create: absent or empty becomes `null`. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const optionalId = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional()
  .refine(
    (v) => v === null || v === undefined || !Number.isNaN(Date.parse(v)),
    "Enter a valid date.",
  )
  .transform((v) => (v ? new Date(v) : null));

/** Update: absent stays `undefined`; an explicit empty string clears to `null`. */
const patchText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

const patchId = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

const patchDate = z
  .string()
  .trim()
  .nullable()
  .optional()
  .refine(
    (v) => !v || !Number.isNaN(Date.parse(v)),
    "Enter a valid date.",
  )
  .transform((v) => (v ? new Date(v) : v === undefined ? undefined : null));

export const issueStatusSchema = z.enum(ISSUE_STATUSES);
export const issueTypeSchema = z.enum(ISSUE_TYPES);
export const prioritySchema = z.enum(PRIORITIES);
export const severitySchema = z.enum(SEVERITIES);

/* --------------------------------------------------------------- projects */

export const projectKeySchema = trimmed(10)
  .min(2, "Use at least 2 characters.")
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Start with a letter and use letters and numbers only.",
  )
  .transform((v) => v.toUpperCase());

export const createProjectSchema = z.object({
  name: trimmed(80).min(2, "Give the project a name."),
  key: projectKeySchema,
  description: optionalText(2000),
  memberIds: z.array(z.string()).default([]),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  projectId: z.string().min(1),
  name: trimmed(80).min(2, "Give the project a name."),
  description: optionalText(2000),
  isArchived: z.boolean().optional(),
  isDefaultProject: z.boolean().optional(),
});

/*
 * Deletion asks for the project's name to be typed back. The check is repeated
 * on the server — a disabled button is a courtesy to the person, not a control.
 * The key is deliberately absent from both schemas: issue keys (ENG-1, ENG-2)
 * are immutable and printed on every issue, so renaming a project's key would
 * silently orphan every reference to it.
 */
export const deleteProjectSchema = z.object({
  projectId: z.string().min(1),
  confirmName: z.string().min(1, "Type the project name to confirm."),
});

export const projectMemberSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

export const createLabelSchema = z.object({
  projectId: z.string().min(1),
  name: trimmed(40).min(1, "Give the label a name."),
  color: trimmed(9).regex(/^#[0-9A-Fa-f]{6}$/, "Use a hex colour, e.g. #3B82F6"),
});

/* ----------------------------------------------------------------- issues */

const issueBase = z.object({
  projectId: z.string().min(1, "Choose a project."),
  type: issueTypeSchema,
  title: trimmed(200).min(3, "Give it a title of at least 3 characters."),
  description: optionalText(20_000),
  status: issueStatusSchema.default("BACKLOG"),
  priority: prioritySchema.default("MEDIUM"),
  assigneeId: optionalId,
  labelIds: z.array(z.string()).default([]),
  dueDate: optionalDate,
  parentId: optionalId,

  // Bug-specific — always accepted, required only when type is BUG.
  severity: severitySchema.nullable().optional().default(null),
  stepsToReproduce: optionalText(20_000),
  expectedResult: optionalText(5_000),
  actualResult: optionalText(5_000),
  environment: optionalText(120),
  browser: optionalText(120),
  operatingSystem: optionalText(120),
  versionBuild: optionalText(120),
  affectedModule: optionalText(120),
});

/**
 * A bug still has to say what is wrong, so a description remains mandatory for
 * BUG and optional for everything else.
 *
 * Reproduction steps, expected result and actual result used to be required
 * here too. They are not any more: those fields were removed from the creation
 * form, and a rule the form cannot satisfy would reject every new bug. The
 * columns stay accepted — historical rows keep their values and any other
 * caller may still set them — they are simply no longer demanded.
 */
export const createIssueSchema = issueBase.superRefine((value, ctx) => {
  if (value.type !== "BUG") return;

  if (!value.description) {
    ctx.addIssue({
      code: "custom",
      path: ["description"],
      message: "Describe the problem.",
    });
  }
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;

/**
 * Partial update. Every field is genuinely optional: a key that is absent is
 * left untouched by `updateIssue`, and only keys actually present produce an
 * activity entry.
 */
export const updateIssueSchema = z.object({
  issueId: z.string().min(1),
  title: trimmed(200).min(3, "Give it a title of at least 3 characters.").optional(),
  description: patchText(20_000),
  status: issueStatusSchema.optional(),
  priority: prioritySchema.optional(),
  severity: severitySchema.nullable().optional(),
  assigneeId: patchId,
  dueDate: patchDate,
  parentId: patchId,
  stepsToReproduce: patchText(20_000),
  expectedResult: patchText(5_000),
  actualResult: patchText(5_000),
  environment: patchText(120),
  browser: patchText(120),
  operatingSystem: patchText(120),
  versionBuild: patchText(120),
  affectedModule: patchText(120),
});

export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

/* ------------------------------------------------------------ form errors */

export type FieldErrors = Record<string, string>;

/** Flattens a ZodError into `{ fieldName: firstMessage }` for form rendering. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}
