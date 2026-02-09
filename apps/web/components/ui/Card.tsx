
export function Card({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div
            className={`rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm backdrop-blur-xl transition-all hover:border-slate-700 hover:shadow-md ${className}`}
        >
            {children}
        </div>
    );
}

export function CardHeader({
    title,
    subtitle,
    icon: Icon,
}: {
    title: string;
    subtitle?: string;
    icon?: any;
}) {
    return (
        <div className="flex items-start justify-between mb-4">
            <div>
                <h3 className="text-lg font-medium text-slate-100">{title}</h3>
                {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
            </div>
            {Icon && (
                <div className="p-2 rounded-lg bg-slate-800/50 text-slate-400">
                    <Icon className="h-5 w-5" />
                </div>
            )}
        </div>
    );
}
