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

  /*
   * Replies, gathered under the comment that starts their thread.
   *
   * `parentId` has always been stored correctly -- what was missing is any
   * use of it when laying the conversation out. Replies are kept oldest-first
   * within a thread, which is how a conversation reads, even though the
   * top-level stream below runs newest-first.
   *
   * Each reply is grouped under the *root* of its thread rather than under
   * whatever it directly answers. Every comment carries a Reply control,
   * including replies, so somebody answering a reply produces a comment two
   * deep -- and a thread is drawn one level deep, so grouping by the immediate
   * parent left that comment belonging to a card that renders no replies of
   * its own. It was saved, and then it was nowhere: not in the top-level
   * stream, which is parentless comments only, and not under anything. Walking
   * up to the root means a reply appears in its conversation however deep it
   * was aimed, and no answer can be swallowed by the shape of the thread.
   */
  const repliesByParent = useMemo(() => {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));

    /* Bounded, so a parent chain that somehow points at itself cannot spin. */
    const rootOf = (start: CommentView): string => {
      let current = start;
      for (let hops = 0; current.parentId !== null && hops < 100; hops += 1) {
        const parent = byId.get(current.parentId);
        if (!parent || parent.id === current.id) break;
        current = parent;
      }
      return current.id;
    };

    const map = new Map<string, CommentView[]>();
    for (const comment of comments) {
      if (comment.parentId === null) continue;
      const root = rootOf(comment);
      // A broken chain would resolve to the comment itself; it stays out
      // rather than being listed as a reply to nothing.
      if (root === comment.id) continue;
      const thread = map.get(root);
      if (thread) thread.push(comment);
      else map.set(root, [comment]);
    }
    for (const thread of map.values()) {
      thread.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    return map;
  }, [comments]);

  /* One chronological stream. Sorted here rather than in SQL because the two
     sources are separate queries and the merge is trivial at this size.
     Only top-level comments take a place in it: a reply belongs under its
     parent, not beside it. */
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...activity.map((entry) => ({
        kind: "activity" as const,
        at: entry.createdAt,
        entry,
      })),
      ...comments
        .filter((comment) => comment.parentId === null)
        .map((comment) => ({
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
          {comments.length > 0 ? (
            <span className="prio-tabs__count">{comments.length}</span>
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
              <CommentCard
                key={`c-${item.comment.id}`}
                comment={item.comment}
                replies={repliesByParent.get(item.comment.id) ?? []}
                issueId={issueId}
                currentUser={currentUser}
                mentionable={mentionable}
                editing={editing}
                setEditing={setEditing}
                replyingTo={replyingTo}
                setReplyingTo={setReplyingTo}
                reactingTo={reactingTo}
                setReactingTo={setReactingTo}
                onReact={react}
                onRemove={(id) => void remove(id)}
                onSaveEdit={saveEdit}
                onPostReply={postReply}
              />
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

/**
 * One comment, and the replies that answer it.
 *
 * The replies are rendered *inside* this comment's own `<li>`, which is the
 * whole point: a reply carries a `parentId`, and until now the conversation
 * ignored it and laid every comment out in one flat chronological stream. A
 * reply therefore appeared as an independent top-level comment, and since it
 * was the newest thing on the issue it appeared at the very top -- as far from
 * the comment it was answering as it could get.
 *
 * The card markup is unchanged; it simply lives here now so a parent and a
 * reply render through the same code rather than through two copies of it --
 * which means a reply carries a Reply control of its own, like any comment.
 * Threads are drawn one level deep, so an answer to a reply joins the same
 * thread rather than starting a nested one; `repliesByParent` above is what
 * arranges that, by grouping on the thread's root.
 */
function CommentCard({
  comment,
  replies,
  issueId,
  currentUser,
  mentionable,
  editing,
  setEditing,
  replyingTo,
  setReplyingTo,
  reactingTo,
  setReactingTo,
  onReact,
  onRemove,
  onSaveEdit,
  onPostReply,
}: {
  comment: CommentView;
  replies: CommentView[];
  issueId: string;
  currentUser: IssueConversationProps["currentUser"];
  mentionable: MentionablePerson[];
  editing: string | null;
  setEditing: (id: string | null) => void;
  replyingTo: string | null;
  setReplyingTo: (id: string | null) => void;
  reactingTo: string | null;
  setReactingTo: (id: string | null) => void;
  onReact: (commentId: string, emoji: string) => void;
  onRemove: (commentId: string) => void;
  onSaveEdit: (commentId: string, body: string) => Promise<string | null>;
  onPostReply: (
    parentId: string,
    body: string,
    attachmentIds: string[],
  ) => Promise<string | null>;
}) {
  return (
    <li
      key={`c-${comment.id}`}
      id={`comment-${comment.id}`}
      className="prio-comment"
    >
      <span className="prio-activity__rail" aria-hidden />
      <Avatar
        name={comment.author.name}
        image={comment.author.image}
        size="md"
        className="prio-activity__avatar"
      />

      <div className="prio-comment__card">
        <div className="prio-comment__head">
          <strong className="prio-comment__author">
            {comment.author.name}
          </strong>
          <time
            className="prio-activity__time"
            dateTime={comment.createdAt.toISOString()}
            title={formatDateTime(comment.createdAt)}
            /* See the note in ActivityFeed: relative time may round
               differently between render and hydration. */
            suppressHydrationWarning
          >
            {formatRelative(comment.createdAt)}
          </time>
          {comment.editedAt ? (
            <span
              className="prio-comment__edited"
              title={`Edited ${formatDateTime(comment.editedAt)}`}
            >
              edited
            </span>
          ) : null}

          {/* Authors edit their own; administrators can remove any. */}
          {comment.author.id === currentUser.id ||
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
              {comment.author.id === currentUser.id ? (
                <MenuItem
                  icon={<IconEdit />}
                  onSelect={() => setEditing(comment.id)}
                >
                  Edit
                </MenuItem>
              ) : null}
              {comment.author.id === currentUser.id ? (
                <MenuSeparator />
              ) : null}
              <MenuItem
                danger
                icon={<IconTrash />}
                onSelect={() => onRemove(comment.id)}
              >
                Delete
              </MenuItem>
            </Menu>
          ) : null}
        </div>

        {editing === comment.id ? (
          <CommentComposer
            issueId={issueId}
            author={currentUser}
            mentionable={mentionable}
            initialBody={comment.body}
            submitLabel="Save changes"
            autoFocus
            onCancel={() => setEditing(null)}
            onSubmit={(body) => onSaveEdit(comment.id, body)}
          />
        ) : (
          <>
            <RichText
              value={comment.body}
              mentionable={mentionable}
              className="prio-comment__body"
            />
            {comment.attachments.length > 0 ? (
              <AttachmentGrid
                attachments={comment.attachments}
                currentUserId={currentUser.id}
                isAdmin={currentUser.role === "ADMIN"}
                compact
              />
            ) : null}

            <CommentActions
              comment={comment}
              currentUserId={currentUser.id}
              replying={replyingTo === comment.id}
              picking={reactingTo === comment.id}
              onReply={() =>
                setReplyingTo(
                  replyingTo === comment.id ? null : comment.id,
                )
              }
              onPick={() =>
                setReactingTo(
                  reactingTo === comment.id ? null : comment.id,
                )
              }
              onReact={(emoji) => onReact(comment.id, emoji)}
            />

            {/*
             * The reply editor, directly under the comment it answers.
             *
             * It sits inside this comment's own card rather than beside it or
             * in a panel of its own, so the thing being replied to is still on
             * screen and directly above what is being typed. `Replying to
             * <name>` says which comment that is — a card can be several
             * replies deep in a long thread, and the editor on its own does
             * not say whose words it is answering.
             *
             * Same composer as the one at the foot of the page: same toolbar,
             * same mentions, same attachments, same validation. There is no
             * second editor.
             */}
            {replyingTo === comment.id ? (
              <div className="prio-comment__reply">
                <p className="prio-comment__replyto">
                  Replying to <strong>{comment.author.name}</strong>
                </p>
                <CommentComposer
                  issueId={issueId}
                  author={currentUser}
                  mentionable={mentionable}
                  submitLabel="Save"
                  autoFocus
                  onCancel={() => setReplyingTo(null)}
                  onSubmit={(body, attachmentIds) =>
                    onPostReply(comment.id, body, attachmentIds)
                  }
                />
              </div>
            ) : null}
          </>
        )}
      </div>

      {replies.length > 0 ? (
        <ol className="prio-comment__replies">
          {replies.map((reply) => (
            <CommentCard
              key={reply.id}
              comment={reply}
              replies={[]}
              issueId={issueId}
              currentUser={currentUser}
              mentionable={mentionable}
              editing={editing}
              setEditing={setEditing}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              reactingTo={reactingTo}
              setReactingTo={setReactingTo}
              onReact={onReact}
              onRemove={onRemove}
              onSaveEdit={onSaveEdit}
              onPostReply={onPostReply}
            />
          ))}
        </ol>
      ) : null}
    </li>

  );
}
