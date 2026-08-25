"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { RichText } from "@/components/richtext/RichText";
import { useToast } from "@/components/ui/Toast";
import { IconEdit, IconMore, IconTrash } from "@/components/ui/Icon";
import { formatDateTime, formatRelative } from "@/lib/format";
import { createComment, deleteComment, updateComment } from "@/server/comments";
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
 * Activity and comments as one conversation.
 *
 * The two are interleaved by time rather than split into tabs, because they
 * describe the same thing: what has happened to this issue. They are styled
 * differently — a system event is a thin line on the rail, a comment is a card
 * — so the eye can still separate "someone said" from "something changed".
 *
 * The composer sits inside this block, directly beneath the timeline. Finding
 * where to comment should not require looking for it.
 */

export interface CommentView {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  author: { id: string; name: string; image: string | null };
  attachments: AttachmentView[];
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

  async function post(body: string, attachmentIds: string[]) {
    const result = await createComment({ issueId, body, attachmentIds });
    if (!result.ok) return result.error;

    toast(<>Comment added to {issueKey}</>);
    router.refresh();
    return null;
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

  return (
    <div className="prio-conversation">
      {hiddenCount > 0 && !showAll ? (
        <button
          type="button"
          className="prio-conversation__more"
          onClick={() => setShowAll(true)}
        >
          Show {hiddenCount} earlier {hiddenCount === 1 ? "event" : "events"}
        </button>
      ) : null}

      {timeline.length === 0 ? (
        <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
          Nothing has happened on this issue yet.
        </p>
      ) : (
        <ol className="prio-activity prio-conversation__timeline">
          {visible.map((item) =>
            item.kind === "activity" ? (
              <ActivityFeedItem
                key={`a-${item.entry.id}`}
                entry={item.entry}
                names={names}
              />
            ) : (
              <li key={`c-${item.comment.id}`} className="prio-comment">
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
                    </>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
      )}

      {/* The composer, always visible directly under the timeline. */}
      <div className="prio-conversation__composer">
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
