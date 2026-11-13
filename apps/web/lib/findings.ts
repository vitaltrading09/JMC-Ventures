// How each kind of finding is presented: its plain name, why it can matter,
// and which channels the investigation charts open with.

import { Activity, Gauge, Scale, TrendingUp, Zap, Moon, AlertCircle } from "lucide-react";

export type Channel = "power" | "voltage" | "current" | "pf" | "thd";

export const FINDING_KIND: Record<string, { label: string; icon: any; channels: Channel[]; why: string }> = {
    RULE_HIGH_THD_V: {
        label: "Voltage distortion", icon: Activity, channels: ["thd", "power", "voltage"],
        why: "Distortion at this level can add heating in motors and transformers and upset sensitive electronics. Whether it does here depends on the equipment and on where the distortion comes from, which this measurement alone cannot tell.",
    },
    RULE_LOW_PF: {
        label: "Power factor", icon: Gauge, channels: ["power", "pf"],
        why: "A low power factor means the supply delivers more kVA for the same useful kW. That can raise demand charges and loads cables and transformers. It is not a supply-quality fault.",
    },
    RULE_CURRENT_IMBALANCE: {
        label: "Phase balance", icon: Scale, channels: ["current", "power"],
        why: "When one phase carries noticeably more current, that phase reaches its limit first and the neutral carries more current.",
    },
    RULE_MDI_EXCEEDED: {
        label: "Maximum demand", icon: TrendingUp, channels: ["power"],
        why: "Demand above the contracted maximum normally attracts charges under the supply agreement, and repeated exceedances may lead the utility to raise the contracted value.",
    },
    RULE_VOLTAGE_SAGS: {
        label: "Voltage dips", icon: Zap, channels: ["voltage", "power"],
        why: "Voltage below 207 V can stop drives and contactors and reset controllers. Comparing the dip times with site operation shows whether the cause is on site or on the supply side.",
    },
    RULE_HIGH_BASELOAD: {
        label: "After-hours load", icon: Moon, channels: ["power"],
        why: "Load that stays on outside working hours is energy paid for while the site is idle, unless the equipment genuinely needs to run.",
    },
};
export const kindOf = (type: string | null | undefined) =>
    FINDING_KIND[type ?? ""] ?? { label: "Finding", icon: AlertCircle, channels: ["power", "voltage", "pf", "thd"] as Channel[], why: "" };

export const SEVERITY = {
    1: { label: "Needs action", stripe: "bg-red-500", text: "text-bad" },
    2: { label: "Investigate", stripe: "bg-amber-500", text: "text-warn" },
    3: { label: "Note", stripe: "bg-slate-400", text: "text-muted" },
} as Record<number, { label: string; stripe: string; text: string }>;
export const severityOf = (p: number | null | undefined) => SEVERITY[p ?? 3] ?? SEVERITY[3];

export const CASE_STATUS: Record<string, string> = {
    open: "Open", investigating: "Investigating", action_planned: "Action planned", action_done: "Action done",
    verified: "Verified", not_needed: "No action needed",
};
