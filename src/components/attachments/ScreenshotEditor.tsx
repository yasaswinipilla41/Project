"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { IconWarning } from "@/components/ui/Icon";
import styles from "./ScreenshotEditor.module.css";

/**
 * A small, Snipping-Tool-like markup editor for a single screenshot.
 *
 * Two stacked canvases: `base` holds the photo, `annotation` holds the ink.
 * Keeping them apart is what makes the eraser correct — it clears pixels on
 * the annotation layer only (`destination-out`), never touching the photo
 * underneath. Undo/redo snapshot both layers as PNG data URLs; cropping
 * flattens the two into a new, smaller base and clears the annotation layer,
 * since a crop's whole point is that there is nothing to "undo back into"
 * past it other than the state right before the crop.
 *
 * Everything happens in the browser — nothing here talks to the server. The
 * caller gets a finished PNG `Blob` from `onSave` and decides what to do
 * with it (stage it for a Create form, upload it immediately, etc).
 */

type Tool =
  | "pen"
  | "highlight"
  | "rect"
  | "ellipse"
  | "arrow"
  | "text"
  | "eraser"
  | "crop";

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CropHandle = "nw" | "ne" | "sw" | "se";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;

interface HistoryEntry {
  base: string;
  annotation: string;
  width: number;
  height: number;
}

const DRAW_TOOLS: Exclude<Tool, "crop">[] = [
  "pen",
  "highlight",
  "rect",
  "ellipse",
  "arrow",
  "text",
  "eraser",
];

const TOOL_LABEL: Record<Tool, string> = {
  pen: "Draw",
  highlight: "Highlight",
  rect: "Rectangle",
  ellipse: "Oval",
  arrow: "Arrow",
  text: "Text",
  eraser: "Erase",
  crop: "Crop",
};

const COLORS = [
  "#ef4444",
  "#f59e0b",
  "#facc15",
  "#22c55e",
  "#0593c3",
  "#6e72ad",
  "#1e293b",
  "#ffffff",
];

/**
 * Exactly two, as a real highlighter set offers — yellow and green. Both
 * must be members of `COLORS` above: the toolbar shows one fixed set of
 * swatches and disables the ones that don't apply, rather than swapping in a
 * different set of buttons, so the panel never resizes when the tool changes.
 */
const HIGHLIGHT_COLORS = ["#facc15", "#22c55e"];

/**
 * Highlight strokes are painted at reduced alpha so the photo underneath
 * stays visible — a real `multiply` blend against the annotation layer
 * doesn't work here because that layer starts transparent (see
 * `applyStrokeStyle`), so it would just render as an opaque block once
 * stacked over the photo instead of tinting it.
 */
const HIGHLIGHT_ALPHA = 0.4;

const WIDTHS = [2, 4, 6, 10, 16];

/** Downscale ceiling for the working canvas — keeps a phone-camera photo or
 * a 4K capture fast to draw on without visibly degrading a normal screenshot. */
const MAX_DIMENSION = 1600;

/** Bounds memory: each entry is a pair of PNG data URLs. */
const MAX_HISTORY = 20;

function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load that image."));
    img.src = src;
  });
}

function applyStrokeStyle(
  ctx: CanvasRenderingContext2D,
  tool: Tool,
  color: string,
  width: number,
): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;

  if (tool === "highlight") {
    // Drawn opaque here; the translucent, photo-blending look is applied
    // once per stroke by the caller (see the `highlightStrokeCanvasRef`
    // compositing in the pointer handlers below), so overlapping segments
    // within the same stroke don't compound and darken.
    ctx.lineWidth = Math.max(width * 4, 14);
  } else if (tool === "eraser") {
    ctx.lineWidth = Math.max(width * 3, 14);
    ctx.globalCompositeOperation = "destination-out";
  }
}

function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  tool: Tool,
  start: Point,
  end: Point,
  color: string,
  width: number,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  if (tool === "rect") {
    ctx.strokeRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y),
    );
  } else if (tool === "ellipse") {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.max(Math.abs(end.x - start.x) / 2, 0.01);
    const ry = Math.max(Math.abs(end.y - start.y) / 2, 0.01);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (tool === "arrow") {
    const headLength = Math.max(10, width * 3);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLength * Math.cos(angle - Math.PI / 6),
      end.y - headLength * Math.sin(angle - Math.PI / 6),
    );
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLength * Math.cos(angle + Math.PI / 6),
      end.y - headLength * Math.sin(angle + Math.PI / 6),
    );
    ctx.stroke();
  }

  ctx.restore();
}

export interface TextAnchor {
  h: "left" | "right";
  v: "top" | "bottom";
}

/**
 * The floating text box a click with the Text tool opens. Declared at module
 * scope so it keeps its identity across the parent's renders — see the same
 * note on `FieldError` in `CreateIssueDialog.tsx`.
 */
function TextInputOverlay({
  point,
  dims,
  color,
  fontSize,
  wrapRef,
  onAnchorChange,
  onConfirm,
  onCancel,
}: {
  point: Point;
  dims: { width: number; height: number };
  color: string;
  fontSize: number;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onAnchorChange: (anchor: TextAnchor) => void;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef(false);

  // The canvas may be rendered smaller than its real pixel resolution (it
  // fits the dialog's width); the on-screen text box has to shrink by the
  // same factor so what the user types previews at roughly the size it will
  // actually be drawn at.
  const [displayScale, setDisplayScale] = useState(1);
  // A click near the right/bottom edge of the image would otherwise place
  // this box (anchored by its top-left corner) partly or fully outside
  // `.canvasWrap`, which clips overflow to keep the image's rounded corners
  // — the box would render invisible there. Flipping the anchor to the
  // opposite corner keeps it fully inside; `confirmText` mirrors the same
  // flip so the drawn text lands exactly where this preview showed it.
  const [anchor, setAnchor] = useState<TextAnchor>({ h: "left", v: "top" });

  useLayoutEffect(() => {
    const el = ref.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    el.focus();

    const parent = el.parentElement;
    if (parent && dims.width > 0) {
      const rendered = parent.getBoundingClientRect().width;
      setDisplayScale(rendered / dims.width);
    }

    const wrapRect = wrap.getBoundingClientRect();
    const boxRect = el.getBoundingClientRect();
    const next: TextAnchor = {
      h: boxRect.right > wrapRect.right ? "right" : "left",
      v: boxRect.bottom > wrapRect.bottom ? "bottom" : "top",
    };
    setAnchor(next);
    onAnchorChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish(confirm: boolean) {
    if (doneRef.current) return;
    doneRef.current = true;
    if (confirm) onConfirm(value);
    else onCancel();
  }

  const horizontalStyle =
    anchor.h === "right"
      ? { right: `${100 - (point.x / dims.width) * 100}%` }
      : { left: `${(point.x / dims.width) * 100}%` };
  const verticalStyle =
    anchor.v === "bottom"
      ? { bottom: `${100 - (point.y / dims.height) * 100}%` }
      : { top: `${(point.y / dims.height) * 100}%` };

  return (
    <textarea
      ref={ref}
      className={styles.textInput}
      style={{
        ...horizontalStyle,
        ...verticalStyle,
        color,
        fontSize: fontSize * displayScale,
      }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          finish(true);
        }
      }}
      onBlur={() => finish(true)}
      aria-label="Annotation text"
      // Handle its own Escape (cancel just this text) rather than letting
      // the containing Dialog treat it as "close the whole editor".
      data-local-escape="true"
    />
  );
}

export interface ScreenshotEditorProps {
  open: boolean;
  /** The image to edit — a freshly picked file, or a previously edited one. */
  source: Blob;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}

export function ScreenshotEditor({
  open,
  source,
  onCancel,
  onSave,
}: ScreenshotEditorProps) {
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragSnapshotRef = useRef<HTMLCanvasElement | null>(null);
  const highlightStrokeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const startPointRef = useRef<Point | null>(null);
  const lastPointRef = useRef<Point | null>(null);

  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#ef4444");
  const [strokeWidth, setStrokeWidth] = useState(4);
  const fontSize = Math.max(16, strokeWidth * 5);

  const [history, setHistory] = useState<{
    entries: HistoryEntry[];
    index: number;
  }>({ entries: [], index: -1 });

  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const cropDragRef = useRef<{
    mode: "move" | CropHandle;
    startPointer: Point;
    startRect: Rect;
  } | null>(null);
  const [textEditor, setTextEditor] = useState<Point | null>(null);
  const textAnchorRef = useRef<TextAnchor>({ h: "left", v: "top" });
  const [saving, setSaving] = useState(false);

  const canUndo = history.index > 0;
  const canRedo = history.index >= 0 && history.index < history.entries.length - 1;

  /*
   * The caller mounts this component fresh for each edit session (see
   * `ScreenshotAttachmentField`, which renders it only while there is a
   * source to edit), so every piece of state above already starts at its
   * correct initial value — there is nothing to reset here, only the image
   * to load.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const objectUrl = URL.createObjectURL(source);

    loadImageFromSrc(objectUrl)
      .then((img) => {
        if (cancelled) return;

        const scale = Math.min(
          1,
          MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
        );
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));

        const base = baseCanvasRef.current;
        const annotation = annotationCanvasRef.current;
        if (!base || !annotation) return;

        base.width = width;
        base.height = height;
        annotation.width = width;
        annotation.height = height;

        base.getContext("2d")!.drawImage(img, 0, 0, width, height);
        annotation.getContext("2d")!.clearRect(0, 0, width, height);

        setDims({ width, height });
        setZoomPercent(100);
        setHistory({
          entries: [
            {
              base: base.toDataURL("image/png"),
              annotation: annotation.toDataURL("image/png"),
              width,
              height,
            },
          ],
          index: 0,
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Could not load that image. Try a different file.");
        }
      })
      .finally(() => URL.revokeObjectURL(objectUrl));

    return () => {
      cancelled = true;
    };
  }, [open, source]);

  function pushHistory() {
    const base = baseCanvasRef.current;
    const annotation = annotationCanvasRef.current;
    if (!base || !annotation) return;

    const entry: HistoryEntry = {
      base: base.toDataURL("image/png"),
      annotation: annotation.toDataURL("image/png"),
      width: base.width,
      height: base.height,
    };

    setHistory((prev) => {
      const kept = prev.entries.slice(0, prev.index + 1);
      let entries = [...kept, entry];
      if (entries.length > MAX_HISTORY) {
        entries = entries.slice(entries.length - MAX_HISTORY);
      }
      return { entries, index: entries.length - 1 };
    });
  }

  async function restoreEntry(entry: HistoryEntry) {
    const base = baseCanvasRef.current;
    const annotation = annotationCanvasRef.current;
    if (!base || !annotation) return;

    base.width = entry.width;
    base.height = entry.height;
    annotation.width = entry.width;
    annotation.height = entry.height;

    const [baseImg, annotationImg] = await Promise.all([
      loadImageFromSrc(entry.base),
      loadImageFromSrc(entry.annotation),
    ]);
    base.getContext("2d")!.drawImage(baseImg, 0, 0);
    annotation.getContext("2d")!.drawImage(annotationImg, 0, 0);
    setDims({ width: entry.width, height: entry.height });
  }

  async function undo() {
    if (!canUndo) return;
    const nextIndex = history.index - 1;
    await restoreEntry(history.entries[nextIndex]!);
    setHistory((prev) => ({ ...prev, index: nextIndex }));
  }

  async function redo() {
    if (!canRedo) return;
    const nextIndex = history.index + 1;
    await restoreEntry(history.entries[nextIndex]!);
    setHistory((prev) => ({ ...prev, index: nextIndex }));
  }

  function zoomIn() {
    setZoomPercent((prev) => clamp(prev + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
  }

  function zoomOut() {
    setZoomPercent((prev) => clamp(prev - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
  }

  /**
   * Client coordinates → the canvas's own pixel space, always measured off
   * the annotation canvas regardless of which element the pointer event
   * actually fired on (the canvas itself, or a crop handle sitting on top of
   * it) — that keeps every tool correct however small the canvas is
   * currently being displayed at.
   */
  function pointFromClient(clientX: number, clientY: number): Point {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function getCanvasPoint(event: React.PointerEvent): Point {
    return pointFromClient(event.clientX, event.clientY);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return;
    const point = getCanvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === "text") {
      /*
       * The canvas itself is never focusable, so without this the browser's
       * default mousedown/mouseup handling blurs whatever currently has
       * focus once the click completes — including the floating text input
       * this click is about to open, which would otherwise be focused and
       * then immediately blurred (and auto-confirmed with an empty value) by
       * the very click that opened it. Scoped to just this branch: the
       * drawing tools have no focus to protect, and don't need it.
       */
      event.preventDefault();
      textAnchorRef.current = { h: "left", v: "top" };
      setTextEditor(point);
      return;
    }

    drawingRef.current = true;
    startPointRef.current = point;
    lastPointRef.current = point;

    const annotation = annotationCanvasRef.current;
    if (!annotation) return;
    const ctx = annotation.getContext("2d")!;

    if (tool === "highlight") {
      // Painted on a scratch canvas at full opacity so overlapping segments
      // of the same stroke just overwrite each other, then composited onto
      // the annotation layer at HIGHLIGHT_ALPHA once per pointer move — see
      // the matching branch in handlePointerMove.
      const snap = document.createElement("canvas");
      snap.width = annotation.width;
      snap.height = annotation.height;
      snap.getContext("2d")!.drawImage(annotation, 0, 0);
      dragSnapshotRef.current = snap;

      const stroke = document.createElement("canvas");
      stroke.width = annotation.width;
      stroke.height = annotation.height;
      const strokeCtx = stroke.getContext("2d")!;
      applyStrokeStyle(strokeCtx, tool, color, strokeWidth);
      strokeCtx.beginPath();
      strokeCtx.moveTo(point.x, point.y);
      strokeCtx.lineTo(point.x + 0.01, point.y + 0.01);
      strokeCtx.stroke();
      highlightStrokeCanvasRef.current = stroke;

      ctx.clearRect(0, 0, annotation.width, annotation.height);
      ctx.drawImage(snap, 0, 0);
      ctx.save();
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.drawImage(stroke, 0, 0);
      ctx.restore();
    } else if (tool === "pen" || tool === "eraser") {
      applyStrokeStyle(ctx, tool, color, strokeWidth);
      // A click without a drag still leaves a dot.
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y + 0.01);
      ctx.stroke();
    } else if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
      const snap = document.createElement("canvas");
      snap.width = annotation.width;
      snap.height = annotation.height;
      snap.getContext("2d")!.drawImage(annotation, 0, 0);
      dragSnapshotRef.current = snap;
    } else if (tool === "crop") {
      setCropRect({ x: point.x, y: point.y, w: 0, h: 0 });
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || !drawingRef.current) return;
    const point = getCanvasPoint(event);
    const annotation = annotationCanvasRef.current;
    if (!annotation) return;

    if (tool === "highlight") {
      const stroke = highlightStrokeCanvasRef.current;
      const snap = dragSnapshotRef.current;
      if (!stroke) return;
      const strokeCtx = stroke.getContext("2d")!;
      applyStrokeStyle(strokeCtx, tool, color, strokeWidth);
      const last = lastPointRef.current ?? point;
      strokeCtx.beginPath();
      strokeCtx.moveTo(last.x, last.y);
      strokeCtx.lineTo(point.x, point.y);
      strokeCtx.stroke();
      lastPointRef.current = point;

      const ctx = annotation.getContext("2d")!;
      ctx.clearRect(0, 0, annotation.width, annotation.height);
      if (snap) ctx.drawImage(snap, 0, 0);
      ctx.save();
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.drawImage(stroke, 0, 0);
      ctx.restore();
      return;
    }

    if (tool === "pen" || tool === "eraser") {
      const ctx = annotation.getContext("2d")!;
      applyStrokeStyle(ctx, tool, color, strokeWidth);
      const last = lastPointRef.current ?? point;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      lastPointRef.current = point;
      return;
    }

    if (!startPointRef.current) return;

    if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
      const ctx = annotation.getContext("2d")!;
      const snap = dragSnapshotRef.current;
      ctx.clearRect(0, 0, annotation.width, annotation.height);
      if (snap) ctx.drawImage(snap, 0, 0);
      drawShapePreview(ctx, tool, startPointRef.current, point, color, strokeWidth);
      return;
    }

    if (tool === "crop") {
      const start = startPointRef.current;
      setCropRect({
        x: Math.max(0, Math.min(start.x, point.x)),
        y: Math.max(0, Math.min(start.y, point.y)),
        w: Math.min(annotation.width, Math.abs(point.x - start.x)),
        h: Math.min(annotation.height, Math.abs(point.y - start.y)),
      });
    }
  }

  function handlePointerUp() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    startPointRef.current = null;
    lastPointRef.current = null;
    dragSnapshotRef.current = null;
    highlightStrokeCanvasRef.current = null;
    if (tool !== "crop") pushHistory();
  }

  /**
   * Adjusting the crop selection itself — moving it or dragging a corner
   * handle to resize it. Neither touches the canvas or the undo history;
   * only "Apply crop" does that. Pointer capture is set on whichever element
   * (the selection body, or a handle) received the down event, so the drag
   * tracks correctly even once the pointer leaves that small element.
   */
  function startCropAdjust(event: React.PointerEvent, mode: "move" | CropHandle) {
    if (!cropRect) return;
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    cropDragRef.current = {
      mode,
      startPointer: pointFromClient(event.clientX, event.clientY),
      startRect: { ...cropRect },
    };
  }

  function handleCropAdjustMove(event: React.PointerEvent) {
    const drag = cropDragRef.current;
    const canvas = annotationCanvasRef.current;
    if (!drag || !canvas) return;

    const point = pointFromClient(event.clientX, event.clientY);
    const dx = point.x - drag.startPointer.x;
    const dy = point.y - drag.startPointer.y;
    const start = drag.startRect;

    if (drag.mode === "move") {
      setCropRect({
        x: clamp(start.x + dx, 0, canvas.width - start.w),
        y: clamp(start.y + dy, 0, canvas.height - start.h),
        w: start.w,
        h: start.h,
      });
      return;
    }

    let { x, y, w, h } = start;
    const MIN = 8;

    if (drag.mode.includes("w")) {
      const newX = clamp(start.x + dx, 0, start.x + start.w - MIN);
      w = start.w - (newX - start.x);
      x = newX;
    }
    if (drag.mode.includes("e")) {
      w = clamp(start.w + dx, MIN, canvas.width - start.x);
    }
    if (drag.mode.includes("n")) {
      const newY = clamp(start.y + dy, 0, start.y + start.h - MIN);
      h = start.h - (newY - start.y);
      y = newY;
    }
    if (drag.mode.includes("s")) {
      h = clamp(start.h + dy, MIN, canvas.height - start.y);
    }

    setCropRect({ x, y, w, h });
  }

  function handleCropAdjustEnd() {
    cropDragRef.current = null;
  }

  function confirmText(value: string) {
    const point = textEditor;
    const anchor = textAnchorRef.current;
    setTextEditor(null);
    if (!value.trim() || !point) return;

    const annotation = annotationCanvasRef.current;
    if (!annotation) return;
    const ctx = annotation.getContext("2d")!;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    const lineHeight = fontSize * 1.25;
    const lines = value.split("\n");
    // Mirrors whichever corner the preview box ended up anchored to (see
    // `TextInputOverlay`) so the drawn text lands exactly where it was shown,
    // even when a click near the image's right/bottom edge flipped it.
    const startY = anchor.v === "bottom" ? point.y - lines.length * lineHeight : point.y;
    lines.forEach((line, index) => {
      const y = startY + index * lineHeight;
      if (anchor.h === "right") {
        const width = ctx.measureText(line).width;
        ctx.fillText(line, point.x - width, y);
      } else {
        ctx.fillText(line, point.x, y);
      }
    });
    ctx.restore();
    pushHistory();
  }

  /**
   * Crops both canvases down to `rect`, in place. Purely synchronous DOM
   * canvas work — no history, no tool change — so it's safe to call from
   * both the explicit "Apply crop" button and, below, from Save itself.
   */
  function performCrop(rect: Rect): boolean {
    if (rect.w < 4 || rect.h < 4) return false;
    const base = baseCanvasRef.current;
    const annotation = annotationCanvasRef.current;
    if (!base || !annotation) return false;

    const flattened = document.createElement("canvas");
    flattened.width = base.width;
    flattened.height = base.height;
    const fctx = flattened.getContext("2d")!;
    fctx.drawImage(base, 0, 0);
    fctx.drawImage(annotation, 0, 0);

    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);

    base.width = w;
    base.height = h;
    annotation.width = w;
    annotation.height = h;
    base.getContext("2d")!.drawImage(flattened, x, y, w, h, 0, 0, w, h);
    annotation.getContext("2d")!.clearRect(0, 0, w, h);

    setDims({ width: w, height: h });
    return true;
  }

  function applyCrop() {
    const rect = cropRect;
    setCropRect(null);
    if (!rect || !performCrop(rect)) return;
    setTool("pen");
    pushHistory();
  }

  function handleSave() {
    // A crop the user dragged out but never explicitly applied should still
    // take effect on Save — "I selected an area and saved" is the natural
    // expectation, and skipping this silently discarded the crop before.
    if (tool === "crop" && cropRect) {
      performCrop(cropRect);
      setCropRect(null);
    }

    const base = baseCanvasRef.current;
    const annotation = annotationCanvasRef.current;
    if (!base || !annotation) return;

    setSaving(true);
    const out = document.createElement("canvas");
    out.width = base.width;
    out.height = base.height;
    const octx = out.getContext("2d")!;
    octx.drawImage(base, 0, 0);
    octx.drawImage(annotation, 0, 0);

    out.toBlob((blob) => {
      setSaving(false);
      if (blob) onSave(blob);
    }, "image/png");
  }

  const cropVisible = tool === "crop" && cropRect && cropRect.w > 4 && cropRect.h > 4;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="lg"
      busy={saving}
      title="Edit screenshot"
      description="Draw, highlight, add text or shapes, crop, then save."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={handleSave}
            loading={saving}
            disabled={!ready}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {loadError ? (
        <div style={{ marginBottom: "var(--prio-space-4)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {loadError}
          </Alert>
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.toolGroup}>
          {DRAW_TOOLS.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.toolButton}
              data-active={tool === option}
              disabled={!ready}
              onClick={() => {
                setTool(option);
                setCropRect(null);
                if (option === "highlight" && !HIGHLIGHT_COLORS.includes(color)) {
                  setColor(HIGHLIGHT_COLORS[0]!);
                } else if (option !== "highlight" && HIGHLIGHT_COLORS.includes(color)) {
                  setColor(COLORS[0]!);
                }
              }}
            >
              {TOOL_LABEL[option]}
            </button>
          ))}
        </div>

        {/*
         * The Crop and Color groups below always render the same buttons —
         * only their `disabled` state changes with the active tool/selection.
         * Mounting and unmounting controls here would resize the toolbar
         * every time the tool changes, shifting everything after it under
         * the user's pointer.
         */}
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolButton}
            data-active={tool === "crop"}
            disabled={!ready}
            onClick={() => setTool("crop")}
          >
            Crop
          </button>
          <button
            type="button"
            className={styles.toolButton}
            onClick={applyCrop}
            disabled={!cropVisible}
          >
            Apply crop
          </button>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => setCropRect(null)}
            disabled={!cropVisible}
          >
            Cancel crop
          </button>
        </div>

        <div className={styles.toolGroup}>
          {COLORS.map((option) => {
            const usable = tool !== "highlight" || HIGHLIGHT_COLORS.includes(option);
            return (
              <button
                key={option}
                type="button"
                className={styles.swatch}
                style={{ background: option }}
                data-active={color === option}
                aria-label={`Color ${option}`}
                disabled={!usable}
                onClick={() => setColor(option)}
              />
            );
          })}
          {/* A highlighter has exactly two colors — disabled rather than
              hidden while highlighting, so the group never resizes. */}
          <input
            type="color"
            className={styles.colorInput}
            value={color}
            onChange={(event) => setColor(event.target.value)}
            aria-label="Custom color"
            disabled={tool === "highlight"}
          />
        </div>

        <div className={styles.toolGroup}>
          <select
            className={styles.widthSelect}
            value={strokeWidth}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
            aria-label="Stroke width"
          >
            {WIDTHS.map((option) => (
              <option key={option} value={option}>
                {option}px
              </option>
            ))}
          </select>
        </div>

        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => void undo()}
            disabled={!canUndo}
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => void redo()}
            disabled={!canRedo}
          >
            Redo
          </button>
        </div>

        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolButton}
            onClick={zoomOut}
            disabled={!ready || zoomPercent <= ZOOM_MIN}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className={styles.zoomLabel}>{zoomPercent}%</span>
          <button
            type="button"
            className={styles.toolButton}
            onClick={zoomIn}
            disabled={!ready || zoomPercent >= ZOOM_MAX}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div className={styles.canvasWrap} data-ready={ready} ref={canvasWrapRef}>
        {!ready && !loadError ? (
          <p className={styles.loading}>Loading image…</p>
        ) : null}
        {/*
         * Always mounted, even before the image has loaded — the load effect
         * draws into these refs and flips `ready` only once that succeeds, so
         * the canvases have to exist first. Hidden rather than unmounted
         * while loading; the visible loading text above covers for it.
         */}
        <div
          className={styles.canvasStack}
          hidden={!ready}
          style={{
            width: `${zoomPercent}%`,
            maxWidth: zoomPercent <= 100 ? dims.width || undefined : undefined,
            aspectRatio:
              dims.width && dims.height ? `${dims.width} / ${dims.height}` : undefined,
          }}
        >
          <canvas ref={baseCanvasRef} className={styles.baseCanvas} />
          <canvas
            ref={annotationCanvasRef}
            className={styles.annotationCanvas}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          />
          {/*
           * Positioned as percentages of the image's own pixel dimensions,
           * not raw pixels — that keeps them aligned with the canvas no
           * matter how much smaller than its native resolution it is
           * currently being displayed at.
           */}
          {cropRect ? (
            <div
              className={styles.cropOverlay}
              style={{
                left: `${(cropRect.x / dims.width) * 100}%`,
                top: `${(cropRect.y / dims.height) * 100}%`,
                width: `${(cropRect.w / dims.width) * 100}%`,
                height: `${(cropRect.h / dims.height) * 100}%`,
              }}
              onPointerDown={(event) => startCropAdjust(event, "move")}
              onPointerMove={handleCropAdjustMove}
              onPointerUp={handleCropAdjustEnd}
              onPointerCancel={handleCropAdjustEnd}
            >
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <div
                  key={corner}
                  className={styles.cropHandle}
                  data-corner={corner}
                  onPointerDown={(event) => startCropAdjust(event, corner)}
                  onPointerMove={handleCropAdjustMove}
                  onPointerUp={handleCropAdjustEnd}
                  onPointerCancel={handleCropAdjustEnd}
                />
              ))}
            </div>
          ) : null}
          {textEditor ? (
            <TextInputOverlay
              point={textEditor}
              dims={dims}
              color={color}
              fontSize={fontSize}
              wrapRef={canvasWrapRef}
              onAnchorChange={(anchor) => {
                textAnchorRef.current = anchor;
              }}
              onConfirm={confirmText}
              onCancel={() => setTextEditor(null)}
            />
          ) : null}
        </div>
      </div>

      <p className={styles.hint}>
        {tool === "crop"
          ? "Drag to select an area, then Apply crop."
          : tool === "text"
            ? "Click on the image to add text — Enter to place it, Escape to cancel."
            : "Drag on the image to draw. Undo/redo step through your changes."}
      </p>
    </Dialog>
  );
}
