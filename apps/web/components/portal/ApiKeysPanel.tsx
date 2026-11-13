"use client";

// Portal Settings → API keys (Phase 9). A client admin creates keys for its
// own systems (BMS, BI tools). The key is shown once; GridIQ keeps a hash.
// Each key has scopes and may be limited to some projects. Revoking takes
// effect within a minute (the gateway caches a check for 60 s).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, apiUrl, fmtDate, fmtAgo } from "@/lib/api";
import { Panel, Loading, ErrorBox, Empty, Badge, Button, Field, inputClass, Table } from "@/components/ops/ui";

interface ApiKey {
    id: string; name: string; prefix: string; scopes: string[]; project_ids: string[] | null;
    created_at: string; last_used_at: string | null; revoked_at: string | null;
}
interface Project { id: string; name: string }

const SCOPES: [string, string][] = [
    ["projects:read", "Projects and points"],
    ["readings:read", "Interval readings (1 minute and coarser)"],
    ["readings:raw", "Raw readings (every sample)"],
    ["energy:read", "Energy balance"],
    ["findings:read", "Published findings"],
    ["reports:read", "Published reports and PDFs"],
    ["exports:write", "Request exports"],
];
const DEFAULT = SCOPES.map(([s]) => s).filter((s) => s !== "readings:raw");

export function ApiKeysPanel() {
    const qc = useQueryClient();
    const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => apiGet<ApiKey[]>("/auth/keys") });
    const projects = useQuery({ queryKey: ["v1-projects"], queryFn: () => apiGet<Project[]>("/v1/projects") });
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState<string[]>(DEFAULT);
    const [limit, setLimit] = useState<string[]>([]);
    const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const refresh = () => qc.invalidateQueries({ queryKey: ["api-keys"] });
    const create = useMutation({
        mutationFn: () => apiSend<ApiKey & { key: string }>("POST", "/auth/keys", { name, scopes, project_ids: limit.length ? limit : null }),
        onSuccess: (k) => { setCreated({ key: k.key, name: k.name }); setCopied(false); setName(""); setScopes(DEFAULT); setLimit([]); refresh(); },
    });
    const revoke = useMutation({ mutationFn: (id: string) => apiSend("DELETE", `/auth/keys/${id}`), onSuccess: refresh });
    const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "another project";
    const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

    return (
        <Panel title="API keys" subtitle="For your own systems to read your data through the GridIQ API."
            actions={<a className="text-sm text-accent hover:underline" href={apiUrl("/docs/")} target="_blank" rel="noreferrer">API documentation</a>}>
            {created && (
                <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                    <p className="text-sm text-amber-200">Copy the key for “{created.name}” now. It is shown only once; GridIQ keeps only a fingerprint of it.</p>
                    <div className="flex gap-2">
                        <code className="flex-1 break-all rounded bg-canvas px-2 py-1 text-xs text-ink-2">{created.key}</code>
                        <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(created.key).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</Button>
                        <Button variant="secondary" onClick={() => setCreated(null)}>Done</Button>
                    </div>
                    <p className="text-xs text-muted">Send it as <code>Authorization: Bearer &lt;key&gt;</code> to {apiUrl("/v1/…")}.</p>
                </div>
            )}
            {keys.isLoading ? <Loading /> : keys.error ? <ErrorBox error={keys.error} /> : (keys.data ?? []).length === 0 ? <Empty>No API keys yet.</Empty> : (
                <Table head={["Name", "Key", "Access", "Created", "Last used", ""]}>
                    {keys.data!.map((k) => (
                        <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                            <td className="py-2 pr-4">{k.name}</td>
                            <td className="py-2 pr-4"><code className="text-xs">gq_live_{k.prefix}_…</code></td>
                            <td className="py-2 pr-4 text-xs text-muted">
                                {k.scopes.length} scope{k.scopes.length === 1 ? "" : "s"}{k.scopes.includes("readings:raw") && <span className="ml-1"><Badge tone="amber">raw</Badge></span>}
                                <br />{k.project_ids ? k.project_ids.map(projectName).join(", ") : "all projects"}
                            </td>
                            <td className="py-2 pr-4 text-xs">{fmtDate(k.created_at)}</td>
                            <td className="py-2 pr-4 text-xs">{k.last_used_at ? fmtAgo(k.last_used_at) : "never"}</td>
                            <td className="py-2 text-right">
                                {k.revoked_at ? <Badge tone="grey">revoked</Badge> : (
                                    <Button variant="danger" disabled={revoke.isPending} onClick={() => { if (confirm(`Revoke “${k.name}”? Systems using it stop working within a minute.`)) revoke.mutate(k.id); }}>Revoke</Button>
                                )}
                            </td>
                        </tr>
                    ))}
                </Table>
            )}
            <form className="mt-4 pt-4 border-t border-line space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                <Field label="Name" hint="What uses it, e.g. “BMS integration”"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></Field>
                <div className="grid md:grid-cols-2 gap-3">
                    <Field label="Scopes">
                        <div className="space-y-1">
                            {SCOPES.map(([s, label]) => (
                                <label key={s} className="flex items-center gap-2 text-sm text-ink-3">
                                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes(toggle(scopes, s))} />{label}
                                </label>
                            ))}
                        </div>
                    </Field>
                    <Field label="Projects" hint="None ticked: all projects, including future ones">
                        <div className="space-y-1">
                            {(projects.data ?? []).map((p) => (
                                <label key={p.id} className="flex items-center gap-2 text-sm text-ink-3">
                                    <input type="checkbox" checked={limit.includes(p.id)} onChange={() => setLimit(toggle(limit, p.id))} />{p.name}
                                </label>
                            ))}
                        </div>
                    </Field>
                </div>
                <Button type="submit" disabled={create.isPending || !scopes.length}>Create key</Button>
                <ErrorBox error={create.error ?? revoke.error} />
            </form>
        </Panel>
    );
}
