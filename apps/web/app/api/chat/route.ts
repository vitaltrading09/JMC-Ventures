import { GoogleGenAI } from '@google/genai';

export const maxDuration = 30;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const messages = body.messages || [];
        const context = body.context || '';

        if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
            return Response.json({
                text: 'The Google Gemini API key is not configured. Please add GOOGLE_GENERATIVE_AI_API_KEY to your .env.local file. Get a free key from aistudio.google.com.'
            });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });

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

        // Build conversation history
        const contents = messages
            .map((m: any) => {
                let text = '';
                if (typeof m.content === 'string') text = m.content;
                else if (Array.isArray(m.parts)) text = m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
                else if (Array.isArray(m.content)) text = m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
                return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
            })
            .filter((m: any) => m.parts[0]?.text && m.role !== 'system');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents,
            config: {
                systemInstruction: systemPrompt,
            }
        });

        const text = response.text ?? 'No response generated.';
        return Response.json({ text });

    } catch (error: any) {
        console.error("Chat API Error:", error?.message || error);
        return Response.json({ error: error?.message || 'Failed to process chat request.' }, { status: 500 });
    }
}
