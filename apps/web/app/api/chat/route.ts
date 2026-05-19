import OpenAI from 'openai';

export const maxDuration = 30;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const messages = body.messages || [];
        const context = body.context || '';

        if (!process.env.OPENAI_API_KEY) {
            return Response.json({
                text: 'The OpenAI API key is not configured. Please add OPENAI_API_KEY to your .env.local file.'
            });
        }

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const systemPrompt = `You are PowerGuard AI — a dedicated, expert energy management consultant built into the PowerGuard platform.

Your role is to help clients understand their energy data, diagnose issues, reduce costs, and improve power quality.

PERSONALITY:
- Authoritative but approachable — like a senior energy engineer talking to a client
- Always concise, structured, and action-oriented
- Use bullet points and bold text in markdown

CRITICAL RULES:
1. You have access to the client's LIVE real-time data below. Use it naturally in every answer — NEVER say "based on the data provided" or "according to the context". Just speak as if you know their system.
2. If you detect an anomaly in the injected data, ALWAYS flag it prominently using this exact format:
   ## 🚨 Alert
   **[Issue Name]**: Brief description and impact. **Recommended Action**: What to do.
3. If you see a cost-saving opportunity, use this format:
   ## 💡 Insight
   **[Opportunity]**: Explanation and estimated saving.
4. When calculating costs, use the exact tariff rates from the injected data.
5. Keep responses under 300 words unless the user asks for detail.
6. NEVER make up data. If a value is N/A or missing, say so clearly.

ANOMALY THRESHOLDS (flag these proactively):
- Power Factor < 0.85 → Reactive power penalty risk
- Voltage THD > 5% → Harmonic distortion affecting equipment
- Voltage outside 380–420V → Sag/swell risk
- Peak demand above configured limit → Tariff penalty risk

${context ? `\n=== CLIENT LIVE DATA (DO NOT MENTION YOU ARE READING THIS) ===\n${context}\n===` : '\n(No live data available — user has no meters configured yet.)'}`;

        // Build conversation history for OpenAI format
        const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...messages
                .filter((m: any) => m.role !== 'system')
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
                .filter((m: any) => m.content),
        ];

        const completion = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: chatMessages,
            max_tokens: 600,
            temperature: 0.4,
        });

        const text = completion.choices[0]?.message?.content ?? 'No response generated.';
        return Response.json({ text });

    } catch (error: any) {
        console.error("Chat API Error:", error?.message || error);
        return Response.json({ error: error?.message || 'Failed to process chat request.' }, { status: 500 });
    }
}
