"use client";

import { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Send, Loader2, Sparkles, Bot, User, Zap, AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

export function ChatWidget() {
    const [isOpen, setIsOpen] = useState(false);
    const [userInput, setUserInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [context, setContext] = useState("");
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(true);
    const [messages, setMessages] = useState<ChatMessage[]>([
        { id: '1', role: 'assistant', content: 'Hello! I\'m your **PowerGuard AI Consultant** — I have access to your live energy data. Ask me anything about your sites, power quality, costs, or alerts.' }
    ]);

    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Fetch context + suggestions when chat opens
    useEffect(() => {
        if (!isOpen || context) return;
        const fetchContext = async () => {
            try {
                const token = localStorage.getItem('token');
                if (!token) return;
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081`}/ingestion/ai-context', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    setContext(data.context || '');
                    if (data.suggestions?.length) setSuggestions(data.suggestions);
                }
            } catch (err) {
                console.error("Failed to fetch AI context:", err);
            }
        };
        fetchContext();
    }, [isOpen]);

    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [messages, isLoading]);

    const sendMessage = async (text: string) => {
        if (!text.trim() || isLoading) return;
        setShowSuggestions(false);

        const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
        setMessages(prev => [...prev, userMsg]);
        setUserInput("");
        setIsLoading(true);

        const botId = (Date.now() + 1).toString();
        setMessages(prev => [...prev, { id: botId, role: 'assistant', content: '' }]);

        try {
            // First, proactively fetch the absolute freshest context so the AI has real-time data
            let currentContext = context;
            const token = localStorage.getItem('token');
            if (token) {
                const ctxRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081`}/ingestion/ai-context', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (ctxRes.ok) {
                    const ctxData = await ctxRes.json();
                    currentContext = ctxData.context || '';
                    setContext(currentContext);
                }
            }

            const apiMessages = messages.concat(userMsg).map(m => ({ role: m.role, content: m.content }));

            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: apiMessages, context: currentContext }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `API error ${res.status}`);

            setMessages(prev =>
                prev.map(m => m.id === botId ? { ...m, content: data.text || 'No response.' } : m)
            );
        } catch (err: any) {
            console.error("Chat error:", err);
            setMessages(prev =>
                prev.map(m => m.id === botId ? { ...m, content: `**Error:** ${err.message}` } : m)
            );
        } finally {
            setIsLoading(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        sendMessage(userInput);
    };

    // Detect and style special card sections from AI markdown
    const renderMessage = (content: string) => {
        if (!content) return (
            <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" />
                <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
            </span>
        );

        // Check if content has alert or insight cards — wrap them in styled containers
        const hasAlert = content.includes('## 🚨 Alert');
        const hasInsight = content.includes('## 💡 Insight');

        return (
            <div className={`prose prose-invert prose-sm max-w-none
                ${hasAlert ? '[&_h2:has-text]:text-amber-400' : ''}
                prose-h2:text-sm prose-h2:font-bold prose-h2:mt-2 prose-h2:mb-1
                prose-strong:text-white prose-li:my-0.5 prose-p:my-1
            `}>
                <ReactMarkdown
                    components={{
                        h2: ({ children }) => {
                            const text = String(children);
                            if (text.includes('🚨')) return (
                                <div className="flex items-center gap-1.5 text-amber-400 font-bold text-sm mt-3 mb-1 border-b border-amber-400/30 pb-1">
                                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                                    <span>{text.replace('🚨 ', '')}</span>
                                </div>
                            );
                            if (text.includes('💡')) return (
                                <div className="flex items-center gap-1.5 text-blue-400 font-bold text-sm mt-3 mb-1 border-b border-blue-400/30 pb-1">
                                    <Zap className="w-3.5 h-3.5 flex-shrink-0" />
                                    <span>{text.replace('💡 ', '')}</span>
                                </div>
                            );
                            return <h2 className="text-white font-bold text-sm mt-2 mb-1">{children}</h2>;
                        }
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        );
    };

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
            {isOpen && (
                <div className="w-[360px] sm:w-[420px] h-[540px] max-h-[80vh] bg-slate-900 border border-slate-700/60 rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.6)] flex flex-col mb-4 overflow-hidden animate-in fade-in slide-in-from-bottom-5 duration-300">

                    {/* Header */}
                    <div className="px-4 py-3 bg-gradient-to-r from-blue-900/50 to-indigo-900/50 border-b border-slate-700/60 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <div className="w-9 h-9 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                                <Sparkles className="w-4 h-4" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-white text-sm">PowerGuard AI</h3>
                                <p className="text-xs text-blue-400 font-medium flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                                    Live data connected · Gemini 2.5
                                </p>
                            </div>
                        </div>
                        <button onClick={() => setIsOpen(false)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
                        {messages.map((m) => (
                            <div key={m.id} className={`flex gap-2.5 ${m.role === 'user' ? 'ml-auto flex-row-reverse max-w-[80%]' : 'max-w-[92%]'}`}>
                                <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs ${m.role === 'user' ? 'bg-indigo-500 text-white' : 'bg-slate-800 border border-slate-700 text-blue-400'}`}>
                                    {m.role === 'user' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                                </div>
                                <div className={`px-3.5 py-2.5 rounded-2xl text-sm ${m.role === 'user'
                                    ? 'bg-indigo-500 text-white rounded-tr-none'
                                    : 'bg-slate-800 border border-slate-700/50 text-slate-200 rounded-tl-none'
                                    }`}>
                                    {m.role === 'user' ? m.content : renderMessage(m.content)}
                                </div>
                            </div>
                        ))}

                        {/* Smart suggestion chips — only shown at start */}
                        {showSuggestions && suggestions.length > 0 && messages.length <= 1 && (
                            <div className="flex flex-col gap-1.5 pt-1">
                                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Quick questions</p>
                                {suggestions.map((s, i) => (
                                    <button
                                        key={i}
                                        onClick={() => sendMessage(s)}
                                        className="text-left text-xs px-3 py-2 rounded-xl border border-slate-700 bg-slate-800/60 hover:bg-slate-700/60 hover:border-blue-500/40 text-slate-300 hover:text-white transition-all"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <div className="p-3 border-t border-slate-700/60 bg-slate-900/50">
                        <form onSubmit={handleSubmit} className="relative flex items-center">
                            <input
                                value={userInput}
                                onChange={(e) => setUserInput(e.target.value)}
                                placeholder="Ask about your energy data..."
                                className="w-full bg-slate-800/80 border border-slate-700 text-sm text-white rounded-full pl-4 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all placeholder:text-slate-500"
                            />
                            <button
                                type="submit"
                                disabled={isLoading || !userInput.trim()}
                                className="absolute right-1.5 p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-full transition-colors"
                            >
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            </button>
                        </form>
                        <p className="text-center mt-2 text-[10px] text-slate-600">PowerGuard AI · Always verify critical decisions manually</p>
                    </div>
                </div>
            )}

            {/* FAB */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center justify-center w-14 h-14 rounded-full shadow-[0_0_20px_rgba(59,130,246,0.5)] transition-all duration-300 hover:scale-105 relative ${isOpen ? 'bg-slate-800 text-slate-300 border border-slate-700' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}
            >
                {isOpen ? <X className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
                {!isOpen && (
                    <span className="absolute top-0 right-0 flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500 border-2 border-slate-950" />
                    </span>
                )}
            </button>
        </div>
    );
}
