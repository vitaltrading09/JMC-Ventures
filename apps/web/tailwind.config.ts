import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            // Theme tokens (app/globals.css): one set of names, values per [data-theme].
            // The client portal defaults to light reading surfaces; ops stays dark.
            colors: Object.fromEntries([
                "canvas", "surface", "surface-2", "surface-3", "line", "line-strong",
                "ink", "ink-2", "ink-3", "muted", "faint", "accent", "ok", "warn", "bad",
            ].map((k) => [k, `rgb(var(--c-${k}) / <alpha-value>)`])),
            backgroundImage: {
                "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
                "gradient-conic":
                    "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
            },
        },
    },
    plugins: [],
};
export default config;
