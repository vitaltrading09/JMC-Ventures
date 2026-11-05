"use client";

// Portal settings: branding (shown on reports and share links) and the
// team's users. A client_admin manages its own tenant's users (client roles
// only); a client_viewer sees both read-only. A client_admin also manages
// the tenant's API keys (Phase 9).

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend, fmtDate } from "@/lib/api";
import { useRole, canEdit } from "@/lib/portal";
import { ApiKeysPanel } from "@/components/portal/ApiKeysPanel";
import { PageHeader, Panel, Table, Badge, Loading, ErrorBox, Empty, Button, Field, inputClass } from "@/components/ops/ui";

interface User { id: string; email: string; role: string; created_at: string; }
const ROLE_NAME: Record<string, string> = { client_admin: "Admin", client_viewer: "Viewer" };

export default function PortalSettings() {
    const role = useRole();
    const editable = canEdit(role);
    return (
        <div className="space-y-6 max-w-4xl">
            <PageHeader title="Settings" subtitle={editable ? undefined : "Read only: ask an admin on your team to change these."} />
            <Branding editable={editable} />
            <Users editable={role === "client_admin"} />
            {role === "client_admin" && <ApiKeysPanel />}
        </div>
    );
}

function Branding({ editable }: { editable: boolean }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<{ brand_name: string | null; brand_logo_url: string | null; brand_footer: string | null }>("/ingestion/branding") });
    const [f, setF] = useState({ brand_name: "", brand_logo_url: "", brand_footer: "" });
    useEffect(() => { if (q.data) setF({ brand_name: q.data.brand_name ?? "", brand_logo_url: q.data.brand_logo_url ?? "", brand_footer: q.data.brand_footer ?? "" }); }, [q.data]);
    const save = useMutation({ mutationFn: () => apiSend("PUT", "/ingestion/branding", f), onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }) });
    return (
        <Panel title="Branding" subtitle="Your name and logo on reports and shared links">
            {q.isLoading ? <Loading /> : (
                <form className="grid md:grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                    <Field label="Name"><input disabled={!editable} className={inputClass} value={f.brand_name} onChange={(e) => setF({ ...f, brand_name: e.target.value })} /></Field>
                    <Field label="Logo URL"><input disabled={!editable} className={inputClass} value={f.brand_logo_url} onChange={(e) => setF({ ...f, brand_logo_url: e.target.value })} /></Field>
                    <div className="md:col-span-2"><Field label="Report footer"><input disabled={!editable} className={inputClass} value={f.brand_footer} onChange={(e) => setF({ ...f, brand_footer: e.target.value })} /></Field></div>
                    {editable && <div className="md:col-span-2 flex items-center gap-2"><Button type="submit" disabled={save.isPending}>Save</Button>{save.isSuccess && <span className="text-sm text-emerald-300">Saved</span>}</div>}
                    <div className="md:col-span-2"><ErrorBox error={save.error} /></div>
                </form>
            )}
        </Panel>
    );
}

function Users({ editable }: { editable: boolean }) {
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["users"], enabled: editable, queryFn: () => apiGet<User[]>("/auth/users") });
    const [f, setF] = useState({ email: "", password: "", role: "client_viewer" });
    const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
    const add = useMutation({ mutationFn: () => apiSend("POST", "/auth/users", f), onSuccess: () => { setF({ email: "", password: "", role: "client_viewer" }); refresh(); } });
    const change = useMutation({ mutationFn: ({ id, role }: { id: string; role: string }) => apiSend("PATCH", `/auth/users/${id}`, { role }), onSuccess: refresh });
    const remove = useMutation({ mutationFn: (id: string) => apiSend("DELETE", `/auth/users/${id}`), onSuccess: refresh });
    const me = (() => { try { return JSON.parse(localStorage.getItem("user") || "null")?.id; } catch { return null; } })();

    if (!editable) return <Panel title="Users"><Empty>Your team's users are managed by an admin on your team.</Empty></Panel>;
    return (
        <Panel title="Users" subtitle="Admins can change settings and create share links; viewers can look but not change anything.">
            {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <Table head={["Email", "Role", "Added", ""]}>
                    {q.data!.map((u) => (
                        <tr key={u.id}>
                            <td className="py-2 pr-4">{u.email}{u.id === me && <span className="ml-2"><Badge tone="blue">you</Badge></span>}</td>
                            <td className="py-2 pr-4">
                                {u.id === me ? ROLE_NAME[u.role] ?? u.role : (
                                    <select className={`${inputClass} w-32`} value={u.role} onChange={(e) => change.mutate({ id: u.id, role: e.target.value })}>
                                        {Object.entries(ROLE_NAME).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                )}
                            </td>
                            <td className="py-2 pr-4">{fmtDate(u.created_at)}</td>
                            <td className="py-2 text-right">{u.id !== me && (
                                <Button variant="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Remove ${u.email}? They can no longer sign in.`)) remove.mutate(u.id); }}>Remove</Button>
                            )}</td>
                        </tr>
                    ))}
                </Table>
            )}
            <form className="grid md:grid-cols-4 gap-3 items-end mt-4 pt-4 border-t border-slate-800" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
                <Field label="Email"><input type="email" className={inputClass} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
                <Field label="Temporary password" hint="Share it with them privately"><input type="password" autoComplete="new-password" className={inputClass} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} /></Field>
                <Field label="Role">
                    <select className={inputClass} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                        {Object.entries(ROLE_NAME).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </Field>
                <Button type="submit" disabled={add.isPending}>Add user</Button>
                <div className="md:col-span-4"><ErrorBox error={add.error ?? change.error ?? remove.error} /></div>
            </form>
        </Panel>
    );
}
