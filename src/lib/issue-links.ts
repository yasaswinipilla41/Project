import type { IssueLinkType } from "@prisma/client";

/**
 * The vocabulary of issue relationships.
 *
 * Kept out of `src/server/links.ts` because that file is a `"use server"`
 * module: everything exported from one of those becomes a callable server
 * action, so it may only export async functions. Constants live here, where the
 * client can import them without turning them into network endpoints.
 */

export const LINK_TYPES = [
  "BLOCKS",
  "IS_BLOCKED_BY",
  "RELATES_TO",
  "DUPLICATES",
  "IS_DUPLICATED_BY",
] as const satisfies readonly IssueLinkType[];

export const LINK_LABEL: Record<IssueLinkType, string> = {
  BLOCKS: "blocks",
  IS_BLOCKED_BY: "is blocked by",
  RELATES_TO: "relates to",
  DUPLICATES: "duplicates",
  IS_DUPLICATED_BY: "is duplicated by",
};

/** The same relationship, read from the other issue. */
export const LINK_INVERSE: Record<IssueLinkType, IssueLinkType> = {
  BLOCKS: "IS_BLOCKED_BY",
  IS_BLOCKED_BY: "BLOCKS",
  RELATES_TO: "RELATES_TO",
  DUPLICATES: "IS_DUPLICATED_BY",
  IS_DUPLICATED_BY: "DUPLICATES",
};

/**
 * Display order, so a blocked issue's obstacles are listed before its loose
 * associations rather than in whatever order they were added.
 */
export const LINK_ORDER: IssueLinkType[] = [
  "IS_BLOCKED_BY",
  "BLOCKS",
  "DUPLICATES",
  "IS_DUPLICATED_BY",
  "RELATES_TO",
];
