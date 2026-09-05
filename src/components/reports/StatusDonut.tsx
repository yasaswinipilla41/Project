import type { IssueStatus } from "@prisma/client";
import { STATUS_LABEL } from "@/lib/domain";
import { percent } from "@/lib/format";

/**
 * The project's status mix, as a ring.
 *
 * Inline SVG rather than a charting library: Prio has no chart dependency and
 * a single-ring proportion does not justify adding one. The ring is drawn as
 * one circle per slice, each offset around the circumference by what came
 * before — `stroke-dasharray` with a `pathLength` of 100 means every slice's
 * length *is* its percentage, so no arc maths is needed and the segments
 * cannot drift out of true.
 *
 * Colour comes from `data-status` and the stylesheet, which is the same table
 * the status pills and the distribution bars already read. A status added to
 * the enum therefore arrives here with its own colour and no change to this
 * file.
 *
 * Accessible as a figure with a real caption, and the legend beside it carries
 * every status, count and share as text — the ring is the quick read, the
 * legend is the answer. A screen reader gets the numbers either way.
 */
export function StatusDonut({
  data,
  total,
  label,
}: {
  data: { status: IssueStatus; count: number }[];
  total: number;
  label: string;
}) {
  /* Only what is actually there. A zero-count status would contribute a
     zero-length arc and an empty legend row that says nothing. */
  const present = data.filter((entry) => entry.count > 0);

  if (total === 0 || present.length === 0) {
    return <p className="prio-text-muted">No issues yet.</p>;
  }

  /* Each slice starts where the ones before it end. Built as a running
     reduce rather than by mutating a counter inside a `map`, which the React
     compiler rightly refuses: a value that changes while a component renders
     is a value that can differ between two renders of the same data. Nine
     statuses at most, so the copy per step costs nothing. */
  type Slice = { status: IssueStatus; count: number; share: number; offset: number };
  const slices = present.reduce<Slice[]>((acc, entry) => {
    const previous = acc[acc.length - 1];
    const offset = previous ? previous.offset + previous.share : 0;
    return [...acc, { ...entry, share: (entry.count / total) * 100, offset }];
  }, []);

  return (
    <div className="prio-donut">
      <figure className="prio-donut__figure">
        <svg viewBox="0 0 42 42" role="img" aria-label={label}>
          <circle className="prio-donut__track" cx="21" cy="21" r="15.915" />
          {slices.map((slice) => (
            <circle
              key={slice.status}
              className="prio-donut__seg"
              data-status={slice.status}
              cx="21"
              cy="21"
              r="15.915"
              pathLength={100}
              strokeDasharray={`${slice.share} ${100 - slice.share}`}
              /* 25 puts the first slice at twelve o'clock; the negative offset
                 walks each following slice clockwise by what precedes it. */
              strokeDashoffset={25 - slice.offset}
            >
              <title>{`${STATUS_LABEL[slice.status]}: ${slice.count}`}</title>
            </circle>
          ))}
        </svg>
        <figcaption className="prio-donut__centre">
          <span className="prio-donut__total">{total}</span>
          <span className="prio-donut__totallabel">
            {total === 1 ? "issue" : "issues"}
          </span>
        </figcaption>
      </figure>

      <ul className="prio-donut__legend">
        {slices.map((slice) => (
          <li
            key={slice.status}
            className="prio-donut__legenditem"
            /* The same key the swatch and the ring segment are coloured by, so
               the whole row carries that status's colour rather than only the
               9px square in front of it. */
            data-status={slice.status}
          >
            <span
              className="prio-donut__swatch"
              data-status={slice.status}
              aria-hidden
            />
            <span className="prio-donut__legendlabel prio-truncate">
              {STATUS_LABEL[slice.status]}
            </span>
            <span className="prio-donut__legendvalue">
              {slice.count}
              <span className="prio-donut__legendshare">
                {percent(slice.count, total)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
