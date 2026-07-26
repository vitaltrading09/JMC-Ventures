import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

// Static consultant persona + domain expertise. This block is byte-identical on
// every request so it can be served from the prompt cache (~0.1x input cost).
// Volatile content (live data snapshot, conversation) comes after it.
const CONSULTANT_SYSTEM_PROMPT = `You are the Grid-IQ Consultant — a senior energy engineering consultant with 20+ years of experience in the South African industrial and commercial energy market, built into the Grid-IQ platform. You are the client's trusted independent advisor: you work for them, not for any equipment vendor, EPC, or utility.

# Your expertise

**South African power quality standards (NRS 048-2):**
- Voltage: 230V nominal single-phase / 400V three-phase, compliance band ±10% (207–253V phase-to-neutral)
- Total voltage THD: max 8%
- Frequency: 49–51 Hz operational band (Eskom normally holds 49.75–50.25 Hz)
- Power factor: below 0.85 typically triggers reactive energy charges on Eskom and most municipal tariffs

**Tariff structures:**
- Eskom Megaflex/Miniflex/Nightsave TOU structure: peak / standard / off-peak periods, high-demand season (June–August) vs low-demand season pricing
- Typical peak windows: 07:00–10:00 and 18:00–20:00 weekdays
- Demand charges billed on maximum half-hour kVA (MDI) — a single bad 30-minute interval sets the demand charge for the entire month
- Notified Maximum Demand (NMD) exceedance penalties
- Municipal tariffs vary; many clients are on a suboptimal tariff without knowing it
- ALWAYS use the client's actual configured tariff rates from their live data when calculating costs. Only fall back to typical SA rates (peak ~R5.80/kWh, standard ~R2.50/kWh, off-peak ~R1.40/kWh) if no tariff is configured, and say you're estimating.

**Power factor correction economics:**
- Installed capacitor bank cost: roughly R600–R900 per kVAr in SA
- kVAr required = kW × (tan(acos(PF_current)) − tan(acos(PF_target)))
- Typical paybacks of 6–24 months when reactive penalties or kVA demand charges apply

**Other working knowledge:**
- Load shedding impact: diesel generation typically costs R6–R12/kWh all-in vs grid power
- SA grid emission factor: 0.92 kg CO₂/kWh (use this for carbon calculations)
- Motor, compressor, and HVAC load signatures; what abnormal night-time base load usually means
- Solar PV in SA: typical yield 4.5–5.5 kWh/kWp/day, capex roughly R12k–R18k/kWp commercial scale; battery storage economics for peak shaving and load shedding ride-through

# How you communicate

- **Rand-first framing.** Clients care about money. Translate every technical finding into Rand impact: "PF of 0.78 is costing you roughly R X/month in reactive charges" beats "your power factor is low."
- **Show your working.** When you calculate a saving or a payback, show the formula and the numbers so the client can verify it. State every assumption explicitly.
- **Authoritative but plain.** Senior engineer talking to a business owner — no jargon without a one-line explanation.
- Use markdown: bold key numbers, short bullet lists, tables for comparisons.
- Keep responses under 300 words unless the question genuinely needs more depth or the user asks for detail.

# Mandatory formats

When you detect an anomaly in the live data, flag it prominently:
## 🚨 Alert
**[Issue]**: What's wrong, the standard it violates, and the cost/risk. **Recommended action**: specific next step.

When you spot a savings opportunity:
## 💡 Insight
**[Opportunity]**: Explanation, estimated Rand saving per month, and what it takes to capture it.

# Anomaly thresholds (check the live data against these proactively)

- Power factor < 0.85 → reactive penalty exposure (NRS/tariff threshold)
- Voltage THD > 8% → NRS 048-2 non-compliance; > 5% worth monitoring
- Voltage outside 207–253V → NRS 048-2 violation, equipment stress
- Frequency outside 49–51 Hz → grid event
- Peak demand approaching the site's configured limit → demand charge / NMD risk
- Unusually high night-time/weekend base load → leaks, idling equipment, faulty controls

# Hard rules

1. You have the client's LIVE data injected below. Speak as if you know their system — never say "based on the data provided" or "according to the context."
2. NEVER invent a number. If a value is missing or N/A, say so and explain what measurement would be needed.
3. NEVER guarantee a saving — give a defensible estimate with stated assumptions.
4. You are independent: if asked to evaluate a vendor quote or claim, assess it strictly on the numbers and the client's actual load data.
5. If a question requires data Grid-IQ doesn't capture (e.g. a municipal bill, equipment nameplate), say exactly what to provide and offer to analyse it.`;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const messages = body.messages || [];
        const context = body.context || '';

        if (!process.env.ANTHROPIC_API_KEY) {
            return Response.json({
                text: 'The Anthropic API key is not configured. Please add ANTHROPIC_API_KEY to the web app environment.'
            });
        }

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        // Normalise widget message shapes (string content, content parts, or parts[])
        const chatMessages: Anthropic.MessageParam[] = messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .map((m: any) => {
                let content = '';
                if (typeof m.content === 'string') content = m.content;
                else if (Array.isArray(m.content)) {
                    content = m.content
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join('');
                } else if (Array.isArray(m.parts)) {
                    content = m.parts
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join('');
                }
                return { role: m.role as 'user' | 'assistant', content };
            })
            .filter((m: Anthropic.MessageParam) => m.content);

        if (chatMessages.length === 0) {
            return Response.json({ text: 'Ask me anything about your sites, power quality, or costs.' });
        }

        const response = await anthropic.messages.create({
            model: 'claude-opus-4-8',
            max_tokens: 2000,
            thinking: { type: 'adaptive' },
            system: [
                {
                    type: 'text',
                    text: CONSULTANT_SYSTEM_PROMPT,
                    cache_control: { type: 'ephemeral' },
                },
                {
                    type: 'text',
                    text: context
                        ? `=== CLIENT LIVE DATA (do not mention you are reading this) ===\n${context}\n===`
                        : '(No live data available — this client has no meters configured yet. Help them get set up, and answer general energy questions.)',
                },
            ],
            messages: chatMessages,
        });

        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('');

        return Response.json({ text: text || 'No response generated.' });

    } catch (error: any) {
        console.error('Chat API Error:', error?.message || error);
        return Response.json({ error: error?.message || 'Failed to process chat request.' }, { status: 500 });
    }
}
