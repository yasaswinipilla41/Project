"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { RichText } from "@/components/richtext/RichText";
import { useToast } from "@/components/ui/Toast";
import { IconEdit, IconMore, IconTrash } from "@/components/ui/Icon";
import { formatDateTime, formatRelative } from "@/lib/format";
import { toggleCommentReaction, createComment, deleteComment, updateComment } from "@/server/comments";
import {
  ActivityFeedItem,
  type ActivityEntry,
  type NameLookup,
} from "@/components/issues/ActivityFeed";
import { AttachmentGrid, type AttachmentView } from "@/components/issues/Attachments";
import {
  CommentComposer,
  type MentionablePerson,
} from "@/components/issues/CommentComposer";

/**
 * The discussion on an issue, and the record of what happened to it.
 *
 * Two tabs, not one interleaved list. They answer different questions — "what
 * did the team say" and "what changed, when, by whom" — and mixing them meant
 * a conversation with a dozen status flips through the middle of it. Comments
 * open first because discussion is what people come here for; the audit trail
 * is a click away and complete when you want it.
 *
 * The composer sits under the comments, where the conversation ends. Finding
 * where to reply should not require looking for it.
 */

export interface CommentView {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  parentId: string | null;
  author: { id: string; name: string; image: string | null };
  attachments: AttachmentView[];
  reactions: { emoji: string; userId: string }[];
}

export interface IssueConversationProps {
  issueId: string;
  issueKey: string;
  currentUser: { id: string; name: string; image: string | null; role: string };
  activity: ActivityEntry[];
  comments: CommentView[];
  names: NameLookup;
  mentionable: MentionablePerson[];
}

type TimelineItem =
  | { kind: "activity"; at: Date; entry: ActivityEntry }
  | { kind: "comment"; at: Date; comment: CommentView };

export function IssueConversation({
  issueId,
  issueKey,
  currentUser,
  activity,
  comments,
  names,
  mentionable,
}: IssueConversationProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  /* One chronological stream. Sorted here rather than in SQL because the two
     sources are separate queries and the merge is trivial at this size. */
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...activity.map((entry) => ({
        kind: "activity" as const,
        at: entry.createdAt,
        entry,
      })),
      ...comments.map((comment) => ({
        kind: "comment" as const,
        at: comment.createdAt,
        comment,
      })),
    ];
    return items.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [activity, comments]);

  /*
   * A long-lived issue accumulates a lot of small edits. Showing every one by
   * default pushes the composer off the bottom of the screen, which is exactly
   * how a comment box becomes hard to find — so older entries collapse behind
   * a toggle. Comments are never hidden: they are the part people came to read.
   */
  /* Comments first: it is the reason the page is open. */
  const [tab, setTab] = useState<"comments" | "activity">("comments");

  const RECENT = 12;
  const hiddenCount = Math.max(
    0,
    timeline.filter((item) => item.kind === "activity").length - RECENT,
  );

  const visible = useMemo(() => {
    if (showAll || hiddenCount === 0) return timeline;

    const keepActivityFrom = timeline
      .filter((item) => item.kind === "activity")
      .slice(-RECENT)[0];

    return timeline.filter(
      (item) =>
        item.kind === "comment" ||
        (keepActivityFrom !== undefined && item.at >= keepActivityFrom.at),
    );
  }, [timeline, showAll, hiddenCount]);

  /* Newest first on screen. `timeline` and the collapse above both work in
     chronological order — `slice(-RECENT)` means "the most recent" only while
     the list runs oldest to newest — so the flip happens here, at the end,
     rather than anywhere that would change what counts as recent. */
  const ordered = useMemo(() => [...visible].reverse(), [visible]);

  async function post(body: string, attachmentIds: string[]) {
    const result = await createComment({ issueId, body, attachmentIds });
    if (!result.ok) return result.error;

    toast(<>Comment added to {issueKey}</>);
    router.refresh();
    return null;
  }

  /* A reply is an ordinary comment carrying a parent — the model has had
     `parentId` all along, it simply had no way in from the interface. */
  async function postReply(parentId: string, body: string, attachmentIds: string[]) {
    const result = await createComment({ issueId, body, parentId, attachmentIds });
    if (!result.ok) return result.error;

    setReplyingTo(null);
    toast(<>Reply added to {issueKey}</>);
    router.refresh();
    return null;
  }

  async function react(commentId: string, emoji: string) {
    setReactingTo(null);
    const result = await toggleCommentReaction({ commentId, emoji });
    if (!result.ok) {
      toast(<>{result.error}</>);
      return;
    }
    router.refresh();
  }

  async function saveEdit(commentId: string, body: string) {
    const result = await updateComment({ commentId, body });
    if (!result.ok) return result.error;

    setEditing(null);
    toast(<>Comment updated</>);
    router.refresh();
    return null;
  }

  async function remove(commentId: string) {
    const result = await deleteComment(commentId);
    if (!result.ok) {
      toast(<>{result.error}</>);
      return;
    }
    toast(<>Comment deleted</>);
    router.refresh();
  }

  const commentItems = ordered.filter((item) => item.kind === "comment");
  const activityItems = ordered.filter((item) => item.kind === "activity");
  const shown = tab === "comments" ? commentItems : activityItems;

  return (
    <div className="prio-conversation">
      <div className="prio-tabs" role="tablist" aria-label="Issue discussion">
        <button
          type="button"
          role="tab"
          className="prio-tabs__tab"
          aria-selected={tab === "comments"}
          data-active={tab === "comments" || undefined}
          onClick={() => setTab("comments")}
        >
          Comments
          {commentItems.length > 0 ? (
            <span className="prio-tabs__count">{commentItems.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          className="prio-tabs__tab"
          aria-selected={tab === "activity"}
          data-active={tab === "activity" || undefined}
          onClick={() => setTab("activity")}
        >
          Activity
          {activityItems.length > 0 ? (
            <span className="prio-tabs__count">{activityItems.length}</span>
          ) : null}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
          {tab === "comments"
            ? "No comments yet. Start the discussion below."
            : "Nothing has happened on this issue yet."}
        </p>
      ) : (
        <ol className="prio-activity prio-conversation__timeline">
          {shown.map((item) =>
            item.kind === "activity" ? (
              <ActivityFeedItem
                key={`a-${item.entry.id}`}
                entry={item.entry}
                names={names}
              />
            ) : (
              <li
                key={`c-${item.comment.id}`}
                id={`comment-${item.comment.id}`}
                className="prio-comment"
              >
                <span className="prio-activity__rail" aria-hidden />
                <Avatar
                  name={item.comment.author.name}
                  image={item.comment.author.image}
                  size="md"
                  className="prio-activity__avatar"
                />

                <div className="prio-comment__card">
                  <div className="prio-comment__head">
                    <strong className="prio-comment__author">
                      {item.comment.author.name}
                    </strong>
                    <time
                      className="prio-activity__time"
                      dateTime={item.comment.createdAt.toISOString()}
                      title={formatDateTime(item.comment.createdAt)}
                      /* See the note in ActivityFeed: relative time may round
                         differently between render and hydration. */
                      suppressHydrationWarning
                    >
                      {formatRelative(item.comment.createdAt)}
                    </time>
                    {item.comment.editedAt ? (
                      <span
                        className="prio-comment__edited"
                        title={`Edited ${formatDateTime(item.comment.editedAt)}`}
                      >
                        edited
                      </span>
                    ) : null}

                    {/* Authors edit their own; administrators can remove any. */}
                    {item.comment.author.id === currentUser.id ||
                    currentUser.role === "ADMIN" ? (
                      <Menu
                        align="end"
                        width={188}
                        label="Comment actions"
                        trigger={(props) => (
                          <button
                            type="button"
                            className="prio-comment__menu"
                            aria-label="Comment actions"
                            {...props}
                          >
                            <IconMore size={14} />
                          </button>
                        )}
                      >
                        {item.comment.author.id === currentUser.id ? (
                          <MenuItem
                            icon={<IconEdit />}
                            onSelect={() => setEditing(item.comment.id)}
                          >
                            Edit
                          </MenuItem>
                        ) : null}
                        {item.comment.author.id === currentUser.id ? (
                          <MenuSeparator />
                        ) : null}
                        <MenuItem
                          danger
                          icon={<IconTrash />}
                          onSelect={() => void remove(item.comment.id)}
                        >
                          Delete
                        </MenuItem>
                      </Menu>
                    ) : null}
                  </div>

                  {editing === item.comment.id ? (
                    <CommentComposer
                      issueId={issueId}
                      author={currentUser}
                      mentionable={mentionable}
                      initialBody={item.comment.body}
                      submitLabel="Save changes"
                      autoFocus
                      onCancel={() => setEditing(null)}
                      onSubmit={(body) => saveEdit(item.comment.id, body)}
                    />
                  ) : (
                    <>
                      <RichText
                        value={item.comment.body}
                        mentionable={mentionable}
                        className="prio-comment__body"
                      />
                      {item.comment.attachments.length > 0 ? (
                        <AttachmentGrid
                          attachments={item.comment.attachments}
                          currentUserId={currentUser.id}
                          isAdmin={currentUser.role === "ADMIN"}
                          compact
                        />
                      ) : null}

                      <CommentActions
                        comment={item.comment}
                        currentUserId={currentUser.id}
                        replying={replyingTo === item.comment.id}
                        picking={reactingTo === item.comment.id}
                        onReply={() =>
                          setReplyingTo(
                            replyingTo === item.comment.id ? null : item.comment.id,
                          )
                        }
                        onPick={() =>
                          setReactingTo(
                            reactingTo === item.comment.id ? null : item.comment.id,
                          )
                        }
                        onReact={(emoji) => react(item.comment.id, emoji)}
                      />

                      {replyingTo === item.comment.id ? (
                        <CommentComposer
                          issueId={issueId}
                          author={currentUser}
                          mentionable={mentionable}
                          submitLabel="Reply"
                          autoFocus
                          onCancel={() => setReplyingTo(null)}
                          onSubmit={(body, attachmentIds) =>
                            postReply(item.comment.id, body, attachmentIds)
                          }
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
      )}

      {/* Older events used to collapse behind a toggle so they could not push
          the composer off the screen. With activity in its own tab there is
          nothing to push, so the trail is shown whole. */}
      {tab === "activity" && hiddenCount > 0 && !showAll ? (
        <button
          type="button"
          className="prio-conversation__more"
          onClick={() => setShowAll(true)}
        >
          Show {hiddenCount} earlier {hiddenCount === 1 ? "event" : "events"}
        </button>
      ) : null}

      {/* The composer belongs to the discussion, so it follows it. */}
      <div
        className="prio-conversation__composer"
        hidden={tab !== "comments"}
      >
        <h3 className="prio-conversation__composer-title">Add a comment</h3>
        <CommentComposer
          issueId={issueId}
          author={currentUser}
          mentionable={mentionable}
          onSubmit={post}
        />
      </div>
    </div>
  );
}

/** A like is a reaction; this is the one it uses. */
const LIKE = "\u{1F44D}";

/** A short, fixed set. A full emoji picker is a different feature. */
const REACTIONS = ["\u{1F44D}", "\u{1F389}", "\u{1F440}", "\u2705", "\u2764\uFE0F"];

/**
 * Reply, Like and Add reaction, under each comment.
 *
 * Like is not stored differently from any other reaction — it is a thumbs up
 * with its own button, because it is the one people reach for most and should
 * not cost two clicks. Counts and "have I already reacted" come from the same
 * rows either way, so the two can never disagree.
 */
function CommentActions({
  comment,
  currentUserId,
  replying,
  picking,
  onReply,
  onPick,
  onReact,
}: {
  comment: CommentView;
  currentUserId: string;
  replying: boolean;
  picking: boolean;
  onReply: () => void;
  onPick: () => void;
  onReact: (emoji: string) => void;
}) {
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (const reaction of comment.reactions) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
    if (reaction.userId === currentUserId) mine.add(reaction.emoji);
  }

  const likes = counts.get(LIKE) ?? 0;
  const others = [...counts.entries()].filter(([emoji]) => emoji !== LIKE);

  return (
    <div className="prio-comment__actions">
      <button
        type="button"
        className="prio-comment__action"
        data-active={replying || undefined}
        onClick={onReply}
      >
        Reply
      </button>

      <button
        type="button"
        className="prio-comment__action"
        data-active={mine.has(LIKE) || undefined}
        aria-pressed={mine.has(LIKE)}
        onClick={() => onReact(LIKE)}
      >
        {LIKE} Like{likes > 0 ? ` ${likes}` : ""}
      </button>

      {others.map(([emoji, count]) => (
        <button
          key={emoji}
          type="button"
          className="prio-comment__action"
          data-active={mine.has(emoji) || undefined}
          aria-pressed={mine.has(emoji)}
          onClick={() => onReact(emoji)}
        >
          {emoji} {count}
        </button>
      ))}

      <span className="prio-comment__react">
        <button
          type="button"
          className="prio-comment__action"
          aria-expanded={picking}
          onClick={onPick}
        >
          Add reaction
        </button>

        {picking ? (
          <span className="prio-comment__react-menu" role="menu">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                className="prio-comment__react-option"
                aria-label={`React with ${emoji}`}
                onClick={() => onReact(emoji)}
              >
                {emoji}
              </button>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
