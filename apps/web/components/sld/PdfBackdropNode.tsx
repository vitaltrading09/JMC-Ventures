"use client";

// PDF backdrop rendered as a custom React Flow node so it lives inside the
// transformed viewport — pan/zoom move it together with the meter pins.
// Set draggable:false, selectable:false on the node so it never steals clicks.

import { memo } from "react";
import { Document, Page } from "react-pdf";

export interface PdfBackdropNodeData {
    pdfUrl: string;
    width?: number;
    onPageRendered?: (dims: { width: number; height: number }) => void;
}

function PdfBackdropImpl({ data }: { data: PdfBackdropNodeData }) {
    // Sharpness trick: render the PDF canvas at a much higher pixel density than
    // the display width. We pass `devicePixelRatio` so react-pdf draws the
    // underlying bitmap at width × ratio physical pixels — staying crisp even
    // when React Flow zooms in. Ratio 3 is a good sweet-spot vs memory.
    return (
        <div
            // pointer-events:none so the PDF can't be clicked/dragged.
            // Full opacity + no brightness filter keeps thin black lines crisp even
            // when the canvas is zoomed out to fit-screen. (Earlier opacity:0.85 let
            // the dark slate background bleed through and fade the lines away.)
            className="pointer-events-none select-none"
        >
            <Document
                file={data.pdfUrl}
                loading={<div className="text-slate-500 text-xs p-4">Loading PDF…</div>}
                error={<div className="text-red-400 text-xs p-4">Failed to render PDF</div>}
            >
                <Page
                    pageNumber={1}
                    width={data.width ?? 1400}
                    devicePixelRatio={3}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    onRenderSuccess={(p: any) => {
                        if (p?.width && p?.height && data.onPageRendered) {
                            data.onPageRendered({ width: p.width, height: p.height });
                        }
                    }}
                />
            </Document>
        </div>
    );
}

export default memo(PdfBackdropImpl);
