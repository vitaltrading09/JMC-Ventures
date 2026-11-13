"use client";

// Ops: the assessment price list. Example packages are seeded as drafts: a
// package can be published only once its VAT basis is set (the database
// refuses otherwise). Prices are integer cents.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import { Package, TAX_LABEL, zarCents, toCents } from "@/lib/assessments";
import { PageHeader, Panel, Loading, ErrorBox, Badge, Button, inputClass, Table } from "@/components/ops/ui";

export default function PackagesPage() {
    const q = useQuery({ queryKey: ["packages"], queryFn: () => apiGet<Package[]>("/ingestion/assessment-packages") });
    return (
        <div className="space-y-6">
            <PageHeader title="Packages & prices" subtitle="Example prices from the brief, unpublished until you confirm VAT treatment and what is included. Not market-validated." />
            <Panel title="Packages" subtitle="Same core features for every duration: overview and power-quality reports, data export, consultant chat during the assessment. One site, one meter by default.">
                {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                    <Table head={["Package", "Days", "Price", "VAT basis", "Extra meter", "Day rate", "Retention", "Status", ""]}>
                        {(q.data ?? []).map((p) => <Row key={p.id} p={p} />)}
                    </Table>
                )}
            </Panel>
        </div>
    );
}

function Row({ p }: { p: Package }) {
    const qc = useQueryClient();
    const [f, setF] = useState({
        price: String(Number(p.price_cents) / 100), tax_basis: p.tax_basis ?? "",
        extra: p.extra_meter_price_cents === null ? "" : String(Number(p.extra_meter_price_cents) / 100),
        day: p.day_rate_cents === null ? "" : String(Number(p.day_rate_cents) / 100),
    });
    const [err, setErr] = useState<string | null>(null);
    const save = useMutation({
        mutationFn: (extra: any) => apiSend("PATCH", `/ingestion/assessment-packages/${p.id}`, {
            price_cents: toCents(f.price), ...(f.tax_basis ? { tax_basis: f.tax_basis } : {}),
            ...(f.extra ? { extra_meter_price_cents: toCents(f.extra) } : {}), ...(f.day ? { day_rate_cents: toCents(f.day) } : {}), ...extra,
        }),
        onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ["packages"] }); },
        onError: (e: any) => setErr(e.message),
    });
    return (
        <tr>
            <td className="py-2 pr-3 text-slate-200">{p.name}<div className="text-xs text-slate-500">{p.code}</div>{err && <div className="text-xs text-red-400">{err}</div>}</td>
            <td className="py-2 pr-3 text-slate-300">{p.duration_days}</td>
            <td className="py-2 pr-3"><input className={inputClass + " w-28"} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /><div className="text-xs text-slate-500">{zarCents(p.price_cents)}</div></td>
            <td className="py-2 pr-3">
                <select className={inputClass + " w-44"} value={f.tax_basis} onChange={(e) => setF({ ...f, tax_basis: e.target.value as any })}>
                    <option value="">Not confirmed</option>
                    {Object.entries(TAX_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
            </td>
            <td className="py-2 pr-3"><input className={inputClass + " w-24"} placeholder="R" value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} /></td>
            <td className="py-2 pr-3"><input className={inputClass + " w-24"} placeholder="R" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></td>
            <td className="py-2 pr-3 text-slate-400">{p.retention_months} months</td>
            <td className="py-2 pr-3"><Badge tone={p.status === "published" ? "green" : "grey"}>{p.status}</Badge></td>
            <td className="py-2 pr-3 whitespace-nowrap">
                <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({})}>Save</Button>{" "}
                {p.status === "draft"
                    ? <Button disabled={save.isPending || !f.tax_basis} title={f.tax_basis ? "" : "Set the VAT basis first"} onClick={() => save.mutate({ status: "published" })}>Publish</Button>
                    : <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ status: "draft" })}>Unpublish</Button>}
            </td>
        </tr>
    );
}
