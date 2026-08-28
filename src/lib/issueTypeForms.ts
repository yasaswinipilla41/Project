import type { IssueType } from "@prisma/client";

/**
 * What each work-item type asks for.
 *
 * A Task and a Bug are not the same job, and a form that asks both the same
 * questions gets the same shallow answers. This is the difference: per type,
 * the heading, the summary field's wording, and the long-form prompts that a
 * person in that role would actually be asked for.
 *
 * Where the prompts land is deliberate. Prio's issue model has real columns
 * for a bug's `severity` and `environment`, and the issue page shows both, so
 * those two are stored as themselves. Everything else here is prose, and the
 * issue page has no block for prose — the Description/Expected/Actual panels
 * were removed on purpose. Rather than write to a column nothing renders, the
 * answers are composed into the issue's first comment, which is exactly where
 * this application already puts written detail. No schema change, and nothing
 * is stored where it cannot be read.
 *
 * Only the `prio-create` flow uses any of this; the Issues page keeps its
 * plain form.
 */

export interface TypeSection {
  /** Stable key for the form state. */
  key: string;
  label: string;
  placeholder: string;
  rows?: number;
  /** Renders a select rather than a textarea. */
  options?: readonly string[];
}

export interface IssueTypeForm {
  /** Dialog heading, e.g. "Create Epic". */
  heading: string;
  /** The line under the heading. */
  description: string;
  /** The one-line description on the selector card. */
  cardHint: string;
  /** Wording for the summary field. */
  titleLabel: string;
  titlePlaceholder: string;
  /** Shown when the summary is missing — named for the type. */
  titleRequired: string;
  /** Long-form prompts, composed into the first comment in this order. */
  sections: readonly TypeSection[];
  /** Severity is part of this type's vocabulary (bugs only). */
  showSeverity: boolean;
  /** The real `environment` column, which the issue page renders. */
  showEnvironment: boolean;
}

const STORY_POINTS = ["1", "2", "3", "5", "8"] as const;

export const ISSUE_TYPE_FORM: Record<IssueType, IssueTypeForm> = {
  EPIC: {
    heading: "Create Epic",
    description:
      "A large initiative representing a major business, product, or organizational goal.",
    cardHint: "Large initiative or major business goal.",
    titleLabel: "Epic summary",
    titlePlaceholder: "e.g. Launch User Authentication System",
    titleRequired: "Epic name is required.",
    showSeverity: false,
    showEnvironment: false,
    sections: [
      {
        key: "businessValue",
        label: "Business value",
        placeholder:
          "Why are we building this? What business or user problem does this Epic solve?",
        rows: 3,
      },
      {
        key: "objective",
        label: "Objective",
        placeholder: "What should this Epic achieve?",
        rows: 2,
      },
      {
        key: "scope",
        label: "Scope",
        placeholder:
          "In scope: the major capabilities this Epic covers.\nOut of scope: what it deliberately does not.",
        rows: 4,
      },
      {
        key: "targetUser",
        label: "Target user",
        placeholder: "e.g. End user, Admin, QA",
      },
      {
        key: "successMetrics",
        label: "Success metrics",
        placeholder:
          "e.g. 95% successful login rate, 30% fewer support tickets",
        rows: 2,
      },
      {
        key: "technicalNotes",
        label: "Technical notes",
        placeholder: "Architectural considerations, constraints, known risks.",
        rows: 3,
      },
    ],
  },

  FEATURE: {
    heading: "Create Feature",
    description: "A meaningful product capability that delivers value to users.",
    cardHint: "A product capability or piece of functionality.",
    titleLabel: "Feature title",
    titlePlaceholder: "e.g. Google Sign-In authentication",
    titleRequired: "Feature title is required.",
    showSeverity: false,
    showEnvironment: false,
    sections: [
      {
        key: "userProblem",
        label: "User problem",
        placeholder: "What problem does this Feature solve?",
        rows: 3,
      },
      {
        key: "featureDescription",
        label: "Description",
        placeholder: "Describe the capability and how it should work.",
        rows: 4,
      },
      {
        key: "targetUser",
        label: "Target user",
        placeholder: "e.g. End user, Admin, Recruiter",
      },
      {
        key: "businessValue",
        label: "Business value",
        placeholder: "What value does this Feature provide?",
        rows: 2,
      },
      {
        key: "expectedOutcome",
        label: "Expected outcome",
        placeholder:
          "What should users be able to accomplish once this is built?",
        rows: 2,
      },
      {
        key: "acceptanceCriteria",
        label: "Acceptance criteria",
        placeholder:
          "Given [context], when [action], then [expected result].",
        rows: 4,
      },
      {
        key: "nonFunctional",
        label: "Non-functional needs",
        placeholder: "Performance, security, accessibility, reliability.",
        rows: 2,
      },
      {
        key: "dependencies",
        label: "Dependencies",
        placeholder: "Services, teams or work this depends on.",
        rows: 2,
      },
    ],
  },

  STORY: {
    heading: "Create Story",
    description: "A user-facing requirement described from the user's perspective.",
    cardHint: "A user-facing requirement, from the user's view.",
    titleLabel: "Story title",
    titlePlaceholder: "e.g. Reset password using registered email",
    titleRequired: "Story title is required.",
    showSeverity: false,
    showEnvironment: false,
    sections: [
      {
        key: "userStory",
        label: "User story",
        placeholder: "As a [user], I want [capability], so that [benefit].",
        rows: 3,
      },
      {
        key: "description",
        label: "Description",
        placeholder: "Describe the user need and the expected behaviour.",
        rows: 3,
      },
      {
        key: "preconditions",
        label: "Preconditions",
        placeholder: "What must be true before this Story can be tested?",
        rows: 2,
      },
      {
        key: "acceptanceCriteria",
        label: "Acceptance criteria",
        placeholder:
          "Given [context], when [action], then [expected result].",
        rows: 4,
      },
      {
        key: "edgeCases",
        label: "Edge cases",
        placeholder: "What unusual paths must still behave correctly?",
        rows: 2,
      },
      {
        key: "storyPoints",
        label: "Story points",
        placeholder: "",
        options: STORY_POINTS,
      },
    ],
  },

  TASK: {
    heading: "Create Task",
    description:
      "A specific unit of implementation or operational work to be completed.",
    cardHint: "A specific unit of implementation work.",
    titleLabel: "Task title",
    titlePlaceholder: "e.g. Implement JWT token refresh endpoint",
    titleRequired: "Task title is required.",
    showSeverity: false,
    showEnvironment: false,
    sections: [
      {
        key: "technicalDescription",
        label: "Technical description",
        placeholder: "What needs to be implemented or changed?",
        rows: 3,
      },
      {
        key: "approach",
        label: "Implementation approach",
        placeholder:
          "Technical approach, affected components, APIs, data or configuration changes.",
        rows: 4,
      },
      {
        key: "steps",
        label: "Technical steps",
        placeholder: "1. …\n2. …\n3. …",
        rows: 4,
      },
      {
        key: "preconditions",
        label: "Preconditions",
        placeholder: "What must be available before work begins?",
        rows: 2,
      },
      {
        key: "acceptanceCriteria",
        label: "Technical acceptance criteria",
        placeholder: "What technical conditions must be satisfied?",
        rows: 3,
      },
      {
        key: "testing",
        label: "Testing requirements",
        placeholder: "Unit, integration and end-to-end coverage expected.",
        rows: 2,
      },
      {
        key: "dependencies",
        label: "Dependencies",
        placeholder: "APIs, services, libraries, other tasks or teams.",
        rows: 2,
      },
      {
        key: "storyPoints",
        label: "Estimate",
        placeholder: "",
        options: STORY_POINTS,
      },
    ],
  },

  BUG: {
    heading: "Create Bug",
    description:
      "A defect with reproduction steps and expected versus actual behaviour.",
    cardHint: "A defect — unexpected or incorrect behaviour.",
    titleLabel: "Bug title",
    titlePlaceholder: "e.g. Login fails after session expiration",
    titleRequired: "Bug title is required.",
    showSeverity: true,
    showEnvironment: true,
    sections: [
      {
        key: "problem",
        label: "Problem",
        placeholder: "What is wrong, and who does it affect?",
        rows: 3,
      },
      {
        key: "steps",
        label: "Steps to reproduce",
        placeholder: "1. Open…\n2. Navigate to…\n3. Click…\n4. Observe…",
        rows: 4,
      },
      {
        key: "expected",
        label: "Expected behaviour",
        placeholder: "What should have happened?",
        rows: 2,
      },
      {
        key: "actual",
        label: "Actual behaviour",
        placeholder: "What actually happened?",
        rows: 2,
      },
      {
        key: "frequency",
        label: "Reproduction frequency",
        placeholder: "",
        options: [
          "Always",
          "Often",
          "Sometimes",
          "Rarely",
          "Unable to reproduce",
        ],
      },
      {
        key: "suspectedArea",
        label: "Suspected area",
        placeholder:
          "Where the defect seems to originate. A suspicion, not a diagnosis.",
        rows: 2,
      },
      {
        key: "logs",
        label: "Logs / error message",
        placeholder: "Paste any error output or log lines.",
        rows: 3,
      },
    ],
  },
};

/**
 * Composes the answered prompts into the issue's opening comment.
 *
 * Unanswered prompts are left out entirely rather than written as empty
 * headings — a wall of blank sections reads as though nobody filled the form
 * in, which is worse than a short comment that says only what is known.
 * Returns an empty string when nothing was answered, and the caller then
 * posts no comment at all.
 */
export function composeTypeDetail(
  type: IssueType,
  values: Record<string, string>,
): string {
  const spec = ISSUE_TYPE_FORM[type];
  const parts: string[] = [];

  for (const section of spec.sections) {
    const value = (values[section.key] ?? "").trim();
    if (!value) continue;
    parts.push(`**${section.label}**\n${value}`);
  }

  return parts.join("\n\n");
}
