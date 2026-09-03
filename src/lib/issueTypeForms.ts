import type { IssueType } from "@prisma/client";

/**
 * How each work-item type introduces itself.
 *
 * This used to describe a *different form per type*: a Bug asked for
 * reproduction steps, expected and actual behaviour and an environment, a
 * Story asked for acceptance criteria and points, an Epic for business value
 * and success metrics. Three types, three shapes, and a Bug that could not be
 * filled in the way a Task was.
 *
 * A Story, a Task and a Bug are now the same record: title, description,
 * priority, severity, assignee, attachments, parent and links. The type says
 * which of the three it is and nothing else. Everything a bug reporter used to
 * be prompted for separately belongs in the description, which every type has.
 *
 * What is left here is wording — the dialog's heading, the sentence under it,
 * the line on the selector card, and an error message named for what the
 * person was actually asked for. None of it changes the fields, the layout or
 * the data; it only stops "Create Bug" reading as "Create Epic".
 *
 * The columns those retired prompts wrote to (`stepsToReproduce`,
 * `expectedResult`, `actualResult`, `environment`, and the rest) still exist
 * and still hold what earlier issues recorded. Nothing writes to them from the
 * create flow any more, and nothing was deleted.
 */

export interface IssueTypeForm {
  /** Dialog heading, e.g. "Create Bug". */
  heading: string;
  /** The line under the heading. */
  description: string;
  /** The one-line description on the selector card. */
  cardHint: string;
  /** Shown when the summary is missing — named for the type. */
  titleRequired: string;
}

export const ISSUE_TYPE_FORM: Record<IssueType, IssueTypeForm> = {
  EPIC: {
    heading: "Create Epic",
    description:
      "A large initiative representing a major business, product, or organizational goal.",
    cardHint: "Large initiative or major business goal.",
    titleRequired: "Epic summary is required.",
  },

  FEATURE: {
    heading: "Create Feature",
    description: "A meaningful product capability that delivers value to users.",
    cardHint: "A product capability or piece of functionality.",
    titleRequired: "Feature summary is required.",
  },

  STORY: {
    heading: "Create Story",
    description:
      "A user-facing requirement described from the user's perspective.",
    cardHint: "A user-facing requirement, from the user's view.",
    titleRequired: "Story summary is required.",
  },

  TASK: {
    heading: "Create Task",
    description:
      "A specific unit of implementation or operational work to be completed.",
    cardHint: "A specific unit of implementation work.",
    titleRequired: "Task summary is required.",
  },

  BUG: {
    heading: "Create Bug",
    description:
      "A defect. Describe what happened, what should have happened, and how to reproduce it.",
    cardHint: "A defect — unexpected or incorrect behaviour.",
    titleRequired: "Bug summary is required.",
  },
};

/**
 * The placeholder in the description box, per type.
 *
 * The *field* is the same field for every type — same name, same column, same
 * size, same position. Only the example text differs, which is a prompt rather
 * than a structure: a bug reporter is reminded that steps and expected
 * behaviour go in here, and nothing stops them writing anything else, or a
 * task author writing steps of their own.
 */
export const DESCRIPTION_PLACEHOLDER: Record<IssueType, string> = {
  EPIC: "What is this initiative, what does it cover, and how will we know it worked?",
  FEATURE:
    "What should this do, who is it for, and what does “done” look like?",
  STORY:
    "As a [user], I want [capability], so that [benefit].\n\nAcceptance criteria, preconditions and edge cases all belong here.",
  TASK: "What needs to be implemented or changed, and how?",
  BUG: "What happened, and what should have happened instead?\n\nSteps to reproduce:\n1. …\n2. …\n\nEnvironment, logs and anything else worth knowing.",
};
