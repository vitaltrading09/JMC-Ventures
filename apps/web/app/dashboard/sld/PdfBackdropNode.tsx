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
    return (
        <div
            // pointer-events:none so the PDF can't be clicked/dragged.
            // Brightness boost makes the (typically white) PDF readable on dark theme.
            className="pointer-events-none select-none"
            style={{ filter: "brightness(1.4) contrast(0.95)", opacity: 0.85 }}
        >
            <Document
                file={data.pdfUrl}
                loading={<div className="text-slate-500 text-xs p-4">Loading PDF…</div>}
                error={<div className="text-red-400 text-xs p-4">Failed to render PDF</div>}
            >
                <Page
                    pageNumber={1}
                    width={data.width ?? 1400}
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
