"use client";

import { Card } from "@/components/ui/Card";
import { Bell, Lock, Moon, User, Globe, Shield } from "lucide-react";
import Link from "next/link";

export default function SettingsPage() {
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-white">Settings</h1>
                <p className="text-slate-400 mt-2">
                    Manage your account preferences and platform configuration.
                </p>
            </div>

            <div className="grid gap-6">
                {/* Profile Section */}
                <Card>
                    <div className="p-6 border-b border-slate-800">
                        <h2 className="text-lg font-medium text-white flex items-center gap-2">
                            <User className="h-5 w-5 text-blue-500" />
                            Profile Information
                        </h2>
                    </div>
                    <div className="p-6 grid gap-6 md:grid-cols-2">
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-400">Full Name</label>
                            <input type="text" defaultValue="John Smith" className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-400">Email Address</label>
                            <input type="email" defaultValue="admin@powerguard.com" className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                    </div>
                    <div className="px-6 py-4 bg-slate-900/50 rounded-b-xl border-t border-slate-800 flex justify-end">
                        <button className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                            Save Changes
                        </button>
                    </div>
                </Card>

                {/* Preferences Grid */}
                <div className="grid gap-6 md:grid-cols-2">
                    <Link href="/dashboard/settings/data">
                        <Card className="p-6 h-full hover:border-blue-500/30 cursor-pointer transition-all group">
                            <div className="flex items-center gap-4 mb-6">
                                <div className="p-3 rounded-lg bg-blue-500/10 text-blue-400 group-hover:bg-blue-500 group-hover:text-white transition-colors">
                                    <Globe className="h-6 w-6" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-medium text-white group-hover:text-blue-400 transition-colors">Data Management</h3>
                                    <p className="text-sm text-slate-400">Import load profiles and manage historical data.</p>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500 w-3/4" />
                                </div>
                                <p className="text-xs text-slate-500 text-right">75% Storage Used</p>
                            </div>
                        </Card>
                    </Link>

                    <Card className="p-6">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="p-3 rounded-lg bg-purple-500/10 text-purple-400">
                                <Bell className="h-6 w-6" />
                            </div>
                            <div>
                                <h3 className="text-lg font-medium text-white">Notifications</h3>
                                <p className="text-sm text-slate-400">Manage how you receive alerts.</p>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <span className="text-slate-300">Email Alerts</span>
                                <div className="h-6 w-11 rounded-full bg-blue-600 relative cursor-pointer">
                                    <div className="absolute right-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm" />
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-slate-300">Push Notifications</span>
                                <div className="h-6 w-11 rounded-full bg-slate-700 relative cursor-pointer">
                                    <div className="absolute left-1 top-1 h-4 w-4 rounded-full bg-slate-400 shadow-sm" />
                                </div>
                            </div>
                        </div>
                    </Card>

                    <Card className="p-6">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="p-3 rounded-lg bg-orange-500/10 text-orange-400">
                                <Shield className="h-6 w-6" />
                            </div>
                            <div>
                                <h3 className="text-lg font-medium text-white">Security</h3>
                                <p className="text-sm text-slate-400">2FA and password settings.</p>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <button className="w-full flex items-center justify-between px-4 py-3 bg-slate-900 border border-slate-700 rounded-lg hover:border-slate-500 transition-colors">
                                <span className="text-slate-300">Change Password</span>
                                <Lock className="h-4 w-4 text-slate-500" />
                            </button>
                            <button className="w-full flex items-center justify-between px-4 py-3 bg-slate-900 border border-slate-700 rounded-lg hover:border-slate-500 transition-colors">
                                <span className="text-slate-300">Two-Factor Auth</span>
                                <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded">Enabled</span>
                            </button>
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}
