import { getCurrentUser } from "@/lib/session";
import { TEMPLATE_FILENAME } from "@/lib/importTemplate";
import { importTemplateWorkbook } from "@/server/importTemplateFile";

/**
 * The import template, as a download.
 *
 * A route handler rather than a server action for the reason the export is
 * one: the browser needs a response with `Content-Disposition` to save a file.
 *
 * The file is the same for everybody and holds nothing about anybody, so the
 * only check is that the caller is signed in — the same bar as the Import
 * button that offers it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const bytes = await importTemplateWorkbook();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILENAME}"`,
      "Cache-Control": "no-store",
    },
  });
}
