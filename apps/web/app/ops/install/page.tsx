"use client";

// Install wizard: box → client → project → point → CT/PT/sign → install.
// After install the deployment page shows the live commissioning checklist.

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { apiGet, apiSend } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/ops";
import { PageHeader, Panel, Loading, ErrorBox, Button, Field, inputClass, Empty } from "@/components/ops/ui";

interface Device { id: string; code: string | null; name: string; status: string; model: string | null; ct_ratio: string | null; pt_ratio: string | null; }
interface Tenant { id: string; name: string; kind: string; }
interface ProjectRow { id: string; name: string; tenant_id: string; end_client_name: string | null; status: string; }
interface Point { id: string; name: string; role: string; deployment_id: string | null; device_code: string | null; device_name: string | null; archived_at: string | null; parent_point_id: string | null; }

const STEPS = ["Box", "Client", "Project", "Point", "Configuration"];

function localNow() {
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
}

export default function InstallPage() {
    return <Suspense fallback={<Loading />}><Wizard /></Suspense>;
}

function Wizard() {
    const router = useRouter();
    const search = useSearchParams();
    const [deviceId, setDeviceId] = useState(search.get("device") ?? "");
    const [tenantId, setTenantId] = useState("");
    const [projectId, setProjectId] = useState("");
    const [pointId, setPointId] = useState("");
    const [newProject, setNewProject] = useState({ name: "", end_client_name: "", address: "" });
    const [newPoint, setNewPoint] = useState({ name: "", role: "incomer", nominal_voltage_v: "230", ct_primary_a: "", parent_point_id: "" });
    const [cfg, setCfg] = useState({ installed_at: localNow(), ct_ratio_configured: "", pt_ratio_configured: "", power_sign: "1", scale_correction: "1" });

    const devices = useQuery({ queryKey: ["devices"], queryFn: () => apiGet<Device[]>("/ingestion/devices") });
    const tenants = useQuery({ queryKey: ["tenants"], queryFn: () => apiGet<Tenant[]>("/ingestion/tenants") });
    const projects = useQuery({
        queryKey: ["projects", tenantId], enabled: !!tenantId,
        queryFn: () => apiGet<ProjectRow[]>(`/ingestion/projects?tenant_id=${tenantId}`),
    });
    const project = useQuery({
        queryKey: ["project", projectId], enabled: !!projectId && projectId !== "new",
        queryFn: () => apiGet<{ points: Point[] }>(`/ingestion/projects/${projectId}`),
    });

    const available = (devices.data ?? []).filter((d) => d.status === "available" || d.status === "reserved" || d.status === "maintenance" || d.id === deviceId);
    const device = available.find((d) => d.id === deviceId);
    const freePoints = (project.data?.points ?? []).filter((p) => !p.archived_at && !p.deployment_id);
    const step = !deviceId ? 0 : !tenantId ? 1 : !projectId ? 2 : !pointId ? 3 : 4;

    const install = useMutation({
        mutationFn: async () => {
            let pid = projectId;
            if (pid === "new") {
                pid = (await apiSend<{ id: string }>("POST", "/ingestion/projects", { tenant_id: tenantId, ...clean(newProject) })).id;
            }
            let ptId = pointId;
            if (ptId === "new") {
                ptId = (await apiSend<{ id: string }>("POST", `/ingestion/projects/${pid}/points`, clean(newPoint))).id;
            }
            return apiSend<{ id: string }>("POST", "/ingestion/deployments", {
                device_id: deviceId, measurement_point_id: ptId,
                installed_at: new Date(cfg.installed_at).toISOString(),
                power_sign: Number(cfg.power_sign), scale_correction: Number(cfg.scale_correction) || 1,
                ...(cfg.ct_ratio_configured ? { ct_ratio_configured: Number(cfg.ct_ratio_configured) } : {}),
                ...(cfg.pt_ratio_configured ? { pt_ratio_configured: Number(cfg.pt_ratio_configured) } : {}),
            });
        },
        onSuccess: (dep) => router.push(`/ops/deployments/${dep.id}`),
    });

    const clients = useMemo(() => (tenants.data ?? []).filter((t) => t.kind === "client"), [tenants.data]);

    return (
        <div className="max-w-3xl">
            <PageHeader title="Deploy a meter" subtitle="Record where a meter is connected. Readings are attributed from the install time; the commissioning checklist runs for 15 minutes." />
            <ol className="flex flex-wrap gap-2 mb-6">
                {STEPS.map((s, i) => (
                    <li key={s} className={`flex items-center gap-1.5 text-sm px-3 py-1 rounded-full border ${
                        i < step ? "border-emerald-500/40 text-emerald-300" : i === step ? "border-blue-500/50 text-blue-200 bg-blue-600/10" : "border-slate-700 text-slate-500"}`}>
                        {i < step && <Check className="h-3.5 w-3.5" />}{i + 1}. {s}
                    </li>
                ))}
            </ol>

            <div className="space-y-4">
                <Panel title="1. Box">
                    {devices.isLoading ? <Loading /> : available.length === 0 ? <Empty>No meter in stock. Add one on the Fleet page.</Empty> : (
                        <select className={inputClass} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                            <option value="">Choose a box…</option>
                            {available.map((d) => <option key={d.id} value={d.id}>{d.code ?? d.name} {d.model ? `· ${d.model}` : ""} ({d.status.replace("_", " ")})</option>)}
                        </select>
                    )}
                </Panel>

                {deviceId && (
                    <Panel title="2. Client">
                        <select className={inputClass} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setProjectId(""); setPointId(""); }}>
                            <option value="">Choose a client…</option>
                            {clients.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                    </Panel>
                )}

                {tenantId && (
                    <Panel title="3. Project">
                        <select className={inputClass} value={projectId} onChange={(e) => { setProjectId(e.target.value); setPointId(e.target.value === "new" ? "new" : ""); }}>
                            <option value="">Choose a project…</option>
                            {(projects.data ?? []).filter((p) => p.status !== "archived").map((p) => (
                                <option key={p.id} value={p.id}>{p.name}{p.end_client_name ? ` (${p.end_client_name})` : ""}</option>
                            ))}
                            <option value="new">+ New project</option>
                        </select>
                        {projectId === "new" && (
                            <div className="grid grid-cols-2 gap-3 mt-3">
                                <Field label="Project name"><input className={inputClass} value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} placeholder="ABC Foods – Germiston audit" /></Field>
                                <Field label="End client"><input className={inputClass} value={newProject.end_client_name} onChange={(e) => setNewProject({ ...newProject, end_client_name: e.target.value })} /></Field>
                                <div className="col-span-2"><Field label="Address"><input className={inputClass} value={newProject.address} onChange={(e) => setNewProject({ ...newProject, address: e.target.value })} /></Field></div>
                            </div>
                        )}
                    </Panel>
                )}

                {projectId && (
                    <Panel title="4. Measurement point" subtitle="Where on the site the meter is connected. A point holds one meter at a time.">
                        {projectId !== "new" && (
                            <select className={inputClass} value={pointId} onChange={(e) => setPointId(e.target.value)}>
                                <option value="">Choose a point…</option>
                                {freePoints.map((p) => <option key={p.id} value={p.id}>{p.name} ({ROLE_LABEL[p.role] ?? p.role})</option>)}
                                <option value="new">+ New point</option>
                            </select>
                        )}
                        {pointId === "new" && (
                            <div className="grid grid-cols-2 gap-3 mt-3">
                                <Field label="Point name"><input className={inputClass} value={newPoint.name} onChange={(e) => setNewPoint({ ...newPoint, name: e.target.value })} placeholder="Main incomer" /></Field>
                                <Field label="Role">
                                    <select className={inputClass} value={newPoint.role} onChange={(e) => setNewPoint({ ...newPoint, role: e.target.value })}>
                                        {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                </Field>
                                <Field label="Nominal voltage, phase-to-neutral (V)"><input className={inputClass} value={newPoint.nominal_voltage_v} onChange={(e) => setNewPoint({ ...newPoint, nominal_voltage_v: e.target.value })} /></Field>
                                <Field label="CT primary (A)"><input className={inputClass} value={newPoint.ct_primary_a} onChange={(e) => setNewPoint({ ...newPoint, ct_primary_a: e.target.value })} /></Field>
                                {projectId !== "new" && (
                                    <div className="col-span-2">
                                        <Field label="Parent point (for a sub-load)">
                                            <select className={inputClass} value={newPoint.parent_point_id} onChange={(e) => setNewPoint({ ...newPoint, parent_point_id: e.target.value })}>
                                                <option value="">None (top level)</option>
                                                {(project.data?.points ?? []).filter((p) => !p.archived_at).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                            </select>
                                        </Field>
                                    </div>
                                )}
                            </div>
                        )}
                    </Panel>
                )}

                {pointId && (
                    <Panel title="5. Configuration" subtitle="As set on the meter. A reversed CT can be fixed here with power sign −1, or corrected later (audit-logged).">
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                            <Field label="Connected at (your local time)"><input type="datetime-local" className={inputClass} value={cfg.installed_at} onChange={(e) => setCfg({ ...cfg, installed_at: e.target.value })} /></Field>
                            <Field label="CT ratio on the meter" hint={device?.ct_ratio ? `meter record: ${device.ct_ratio}` : undefined}><input className={inputClass} value={cfg.ct_ratio_configured} onChange={(e) => setCfg({ ...cfg, ct_ratio_configured: e.target.value })} placeholder="e.g. 400" /></Field>
                            <Field label="PT ratio on the meter"><input className={inputClass} value={cfg.pt_ratio_configured} onChange={(e) => setCfg({ ...cfg, pt_ratio_configured: e.target.value })} placeholder="1 for LV" /></Field>
                            <Field label="Power sign">
                                <select className={inputClass} value={cfg.power_sign} onChange={(e) => setCfg({ ...cfg, power_sign: e.target.value })}>
                                    <option value="1">+1 (as measured)</option>
                                    <option value="-1">−1 (CT reversed)</option>
                                </select>
                            </Field>
                            <Field label="Scale correction" hint="Only for a wrong CT ratio on the meter"><input className={inputClass} value={cfg.scale_correction} onChange={(e) => setCfg({ ...cfg, scale_correction: e.target.value })} /></Field>
                        </div>
                        <div className="flex items-center gap-3 mt-4">
                            <Button disabled={install.isPending || (projectId === "new" && !newProject.name) || (pointId === "new" && !newPoint.name)} onClick={() => install.mutate()}>
                                Install and start commissioning
                            </Button>
                        </div>
                        <div className="mt-3"><ErrorBox error={install.error} /></div>
                    </Panel>
                )}
            </div>
        </div>
    );
}

/** Drops empty strings and turns numeric fields into numbers. */
function clean(o: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
        if (v === "") continue;
        out[k] = /_(v|a)$/.test(k) ? Number(v) : v;
    }
    return out;
}
