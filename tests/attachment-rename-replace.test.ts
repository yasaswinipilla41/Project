import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/attachments/route";
import {
  DELETE,
  PATCH,
  PUT,
} from "@/app/api/attachments/[...path]/route";
import { createIssue } from "@/server/issues";
import { renamedFilename } from "@/server/upload-types";
import { storage } from "@/server/storage";
import { actAs, projectByKey } from "./helpers";

/**
 * Renaming an attachment, and replacing its contents in place.
 *
 * Both are edits to a file somebody already uploaded, and the property under
 * test for each is that the attachment stays the *same* attachment: one id,
 * one row, one entry in the list. Editing a screenshot used to post a second
 * file beside the first, which is the behaviour these tests exist to keep
 * from coming back.
 *
 * Driven through the real route handlers rather than a helper, because the
 * authorization and the validation being asserted live there.
 */

const ADMIN = "admin@symbiosystech.com";
const OTHER = "priya.nair@symbiosystech.com";

const createdIssueIds: string[] = [];
const createdAttachmentIds: string[] = [];

/** A PNG: the real signature, then padding. Identified from its own bytes. */
function pngBytes(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.fill(0x41, 8);
  return bytes;
}

/** An MP4: "ftyp" at offset 4, which is what the sniffer looks for. */
function mp4Bytes(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18]);
  bytes.set([...'ftypisom'].map((c) => c.charCodeAt(0)), 4);
  bytes.fill(0x41, 16);
  return bytes;
}

async function anIssue(title: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const created = await createIssue({
    projectId: project.id,
    type: "BUG",
    title,
    priority: "MEDIUM",
  });
  if (!created.ok) throw new Error(created.error);
  createdIssueIds.push(created.data.id);
  return created.data.id;
}

/** Uploads one file to an issue through the real POST route. */
async function attach(
  issueId: string,
  filename: string,
  bytes: Uint8Array,
  type: string,
): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.append("issueId", issueId);
  form.append("file", new File([bytes as BlobPart], filename, { type }), filename);

  const response = await POST(
    new Request("http://test/api/attachments", { method: "POST", body: form }),
  );
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`upload failed: ${body.error}`);
  }
  createdAttachmentIds.push(body.id);
  return body;
}

const routeParams = (id: string) => ({ params: Promise.resolve({ path: [id] }) });

async function rename(id: string, filename: string) {
  return PATCH(
    new Request(`http://test/api/attachments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ filename }),
    }),
    routeParams(id),
  );
}

async function replace(id: string, bytes: Uint8Array, type: string) {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], "edited", { type }));
  return PUT(
    new Request(`http://test/api/attachments/${id}`, {
      method: "PUT",
      body: form,
    }),
    routeParams(id),
  );
}

function rowOf(id: string) {
  return prisma.attachment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      storageKey: true,
      issueId: true,
    },
  });
}

beforeAll(async () => {
  await actAs(ADMIN);
});

afterAll(async () => {
  await prisma.attachment.deleteMany({
    where: { id: { in: createdAttachmentIds } },
  });
  await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
});

describe("the rename rule", () => {
  it("keeps the extension the file already had", () => {
    expect(renamedFilename("QA-Test-Report", "report.xlsx")).toBe(
      "QA-Test-Report.xlsx",
    );
  });

  it("refuses to let a rename change the file type", () => {
    expect(renamedFilename("report.exe", "report.xlsx")).toBe("report.xlsx");
    expect(renamedFilename("payload.sh", "photo.png")).toBe("payload.png");
  });

  it("does not double the extension when it was typed too", () => {
    expect(renamedFilename("evidence.png", "shot.png")).toBe("evidence.png");
  });

  it("strips any path a name arrives with", () => {
    expect(renamedFilename("../../etc/passwd", "note.txt")).toBe("passwd.txt");
  });

  it("refuses a name that is not one", () => {
    expect(renamedFilename("   ", "report.xlsx")).toBeNull();
    expect(renamedFilename(".png", "shot.png")).toBeNull();
  });

  it("leaves an extensionless file extensionless", () => {
    expect(renamedFilename("readme", "LICENSE")).toBe("readme");
  });
});

describe("renaming an attachment", () => {
  it("changes the name and nothing else", async () => {
    const issueId = await anIssue("Rename target");
    const created = await attach(issueId, "login-bug.png", pngBytes(), "image/png");
    const before = await rowOf(created.id);

    const response = await rename(created.id, "Login screen defect");
    expect(response.status).toBe(200);

    const after = await rowOf(created.id);
    expect(after.filename).toBe("Login screen defect.png");
    // The identity of the thing is untouched: same row, same bytes, same type.
    expect(after.id).toBe(before.id);
    expect(after.storageKey).toBe(before.storageKey);
    expect(after.mimeType).toBe(before.mimeType);
    expect(after.byteSize).toBe(before.byteSize);
    expect(after.issueId).toBe(before.issueId);
  });

  it("works for a document as readily as an image", async () => {
    const issueId = await anIssue("Rename a document");
    const created = await attach(
      issueId,
      "report.pdf",
      new Uint8Array([...'%PDF-1.7'].map((c) => c.charCodeAt(0)).concat(Array(64).fill(0x41))),
      "application/pdf",
    );

    await rename(created.id, "QA Test Report");
    expect((await rowOf(created.id)).filename).toBe("QA Test Report.pdf");
  });

  it("works for a video", async () => {
    const issueId = await anIssue("Rename a recording");
    const created = await attach(issueId, "capture.mp4", mp4Bytes(), "video/mp4");

    await rename(created.id, "Steps to reproduce");
    expect((await rowOf(created.id)).filename).toBe("Steps to reproduce.mp4");
  });

  it("refuses an empty name", async () => {
    const issueId = await anIssue("Rename to nothing");
    const created = await attach(issueId, "keep.png", pngBytes(), "image/png");

    const response = await rename(created.id, "   ");
    expect(response.status).toBe(400);
    expect((await rowOf(created.id)).filename).toBe("keep.png");
  });

  it("refuses somebody who did not upload it and is not an administrator", async () => {
    const issueId = await anIssue("Rename by a stranger");
    const created = await attach(issueId, "mine.png", pngBytes(), "image/png");

    await actAs(OTHER);
    const response = await rename(created.id, "theirs");
    expect(response.status).toBe(403);
    expect((await rowOf(created.id)).filename).toBe("mine.png");

    await actAs(ADMIN);
  });
});

describe("replacing an attachment in place", () => {
  it("updates the same attachment rather than adding a second", async () => {
    const issueId = await anIssue("Edit a screenshot");
    const created = await attach(issueId, "screenshot-1.png", pngBytes(128), "image/png");
    const before = await rowOf(created.id);

    const response = await replace(created.id, pngBytes(512), "image/png");
    expect(response.status).toBe(200);

    const after = await rowOf(created.id);
    // Same row, same name, new bytes: one screenshot is one attachment.
    expect(after.id).toBe(before.id);
    expect(after.filename).toBe("screenshot-1.png");
    expect(after.byteSize).toBe(512);
    expect(after.storageKey).not.toBe(before.storageKey);

    const all = await prisma.attachment.findMany({
      where: { issueId },
      select: { id: true, filename: true },
    });
    expect(all).toHaveLength(1);
    expect(all[0]!.filename).toBe("screenshot-1.png");
  });

  it("leaves no orphaned file behind", async () => {
    const issueId = await anIssue("No orphans");
    const created = await attach(issueId, "shot.png", pngBytes(128), "image/png");
    const before = await rowOf(created.id);

    await replace(created.id, pngBytes(256), "image/png");

    /* The provider hands back a stream before it touches the disk, so the
       absence only surfaces on read. Draining it is what asks the question. */
    await expect(
      (async () => {
        const stream = await storage().read(before.storageKey);
        for await (const _chunk of stream as unknown as AsyncIterable<unknown>) {
          // Drain; the error arrives here if the object is gone.
        }
      })(),
    ).rejects.toThrow();
  });

  it("survives being edited twice", async () => {
    const issueId = await anIssue("Edit twice");
    const created = await attach(issueId, "twice.png", pngBytes(128), "image/png");

    await replace(created.id, pngBytes(256), "image/png");
    await replace(created.id, pngBytes(384), "image/png");

    const all = await prisma.attachment.findMany({ where: { issueId } });
    expect(all).toHaveLength(1);
    expect(all[0]!.byteSize).toBe(384);
  });

  it("refuses a replacement of a different kind", async () => {
    const issueId = await anIssue("Image stays an image");
    const created = await attach(issueId, "shot.png", pngBytes(), "image/png");

    const response = await replace(created.id, mp4Bytes(), "video/mp4");
    expect(response.status).toBe(415);
    expect((await rowOf(created.id)).mimeType).toBe("image/png");
  });

  it("refuses content it cannot identify", async () => {
    const issueId = await anIssue("Unknown bytes");
    const created = await attach(issueId, "shot.png", pngBytes(), "image/png");

    const junk = new Uint8Array(64);
    junk.fill(0);
    const response = await replace(created.id, junk, "image/png");
    expect(response.status).toBe(415);
  });

  it("refuses somebody who did not upload it", async () => {
    const issueId = await anIssue("Replace by a stranger");
    const created = await attach(issueId, "mine.png", pngBytes(128), "image/png");

    await actAs(OTHER);
    const response = await replace(created.id, pngBytes(512), "image/png");
    expect(response.status).toBe(403);
    expect((await rowOf(created.id)).byteSize).toBe(128);

    await actAs(ADMIN);
  });
});

describe("removal still works", () => {
  it("removes a renamed and replaced attachment cleanly", async () => {
    const issueId = await anIssue("Remove after editing");
    const created = await attach(issueId, "gone.png", pngBytes(), "image/png");
    await rename(created.id, "still going");
    await replace(created.id, pngBytes(300), "image/png");

    const response = await DELETE(
      new Request(`http://test/api/attachments/${created.id}`, { method: "DELETE" }),
      routeParams(created.id),
    );
    expect(response.status).toBe(200);
    expect(
      await prisma.attachment.count({ where: { id: created.id } }),
    ).toBe(0);
  });
});
