require('dotenv').config();
const { Client, GatewayIntentBits, Events, ThreadAutoArchiveDuration } = require('discord.js');

// ─── Config ───────────────────────────────────────────────────────────────────

// Any URL in message triggers scraping
const CHANNEL_ANY_URL = process.env.CHANNEL_ANY_URL ?? '';
// Only triggers when bot is mentioned (URL in message or in replied-to message)
const CHANNEL_MENTION_ONLY = process.env.CHANNEL_MENTION_ONLY ?? '';

const ALLOWED_CHANNELS = new Set([CHANNEL_ANY_URL, CHANNEL_MENTION_ONLY]);

const SAKURA_API_URL = 'https://api.ai.sakura.ad.jp/v1/chat/completions';

const MODELS = {
    SUMMARY_TEXT:  'Qwen3-Coder-30B-A3B-Instruct',
    SUMMARY_IMAGE: 'preview/Phi-4-multimodal-instruct',
    SMALL:         'preview/Qwen3-0.6B-cpu',
    LARGE:         'Qwen3-Coder-480B-A35B-Instruct-FP8',
};

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

const PRIVATE_PATTERNS = [
    /^https?:\/\/192\.168\./,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
    /^https?:\/\/(localhost|127\.)/,
    /^https?:\/\/0\./,
    /^https?:\/\/\[::1\]/,
];

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^#]*)?$/i;

const SCRAPER_TIMEOUT_MS   = 60_000;
const AI_TIMEOUT_MS        = 300_000;  // 5 min — large models take time
const MAX_CONTEXT_CHARS    = 12_000;   // total chars sent to AI across all pages
const MAX_RECURSIVE_URLS = 5;
const MAX_DISCORD_MSG_LEN = 2000;
const MAX_CONTEXT_HISTORY = 10;

// ─── State ────────────────────────────────────────────────────────────────────

const threadStore = new Map();

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function isPrivateUrl(url) {
    return PRIVATE_PATTERNS.some(p => p.test(url));
}

// Wiki meta-namespaces and other navigation-only paths to skip for recursive scraping
const SKIP_RECURSIVE_RE =
    /\/wiki\/(Wikipedia|Portal|Special|Help|Category|Template|File|Talk|User|WP|MOS)[_:]/i;

function isUsefulRecursiveUrl(url) {
    return !SKIP_RECURSIVE_RE.test(url);
}

function stripThinkTags(text) {
    // Qwen3 thinking models wrap chain-of-thought in <think>...</think>
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

async function sendLong(target, text) {
    if (text.length <= MAX_DISCORD_MSG_LEN) {
        return target.send(text);
    }
    for (let i = 0; i < text.length; i += MAX_DISCORD_MSG_LEN) {
        await target.send(text.slice(i, i + MAX_DISCORD_MSG_LEN));
    }
}

async function replyLong(message, text) {
    if (text.length <= MAX_DISCORD_MSG_LEN) {
        return message.reply(text);
    }
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_DISCORD_MSG_LEN) {
        chunks.push(text.slice(i, i + MAX_DISCORD_MSG_LEN));
    }
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
        await message.channel.send(chunk);
    }
}

// ─── Scraper Client ───────────────────────────────────────────────────────────

async function scrapeUrl(url) {
    const res = await fetchWithTimeout(
        `${process.env.SCRAPER_API_URL}/scrape`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        },
        SCRAPER_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`Scraper HTTP ${res.status} for ${url}`);
    return res.json();
}

async function scrapeMultiple(urls) {
    const res = await fetchWithTimeout(
        `${process.env.SCRAPER_API_URL}/scrape-multiple`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls }),
        },
        SCRAPER_TIMEOUT_MS * urls.length,
    );
    if (!res.ok) throw new Error(`Scraper HTTP ${res.status}`);
    return res.json();
}

// ─── Sakura AI Client ─────────────────────────────────────────────────────────

async function callAI(model, messages) {
    console.log(`[AI] calling ${model} (${messages.length} messages)`);
    const res = await fetchWithTimeout(
        SAKURA_API_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SAKURA_API_KEY}`,
            },
            body: JSON.stringify({ model, messages }),
        },
        AI_TIMEOUT_MS,
    );
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`AI API HTTP ${res.status}: ${body}`);
    }
    const data = await res.json();
    const raw = data.choices[0].message.content ?? '';
    const result = stripThinkTags(raw);
    console.log(`[AI] ${model} responded (${result.length} chars)`);
    return result;
}

// ─── GitHub README Helper ────────────────────────────────────────────────────

const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/\s?#]+)/;

function extractGithubRepo(url) {
    const m = url.match(GITHUB_REPO_RE);
    return m ? { owner: m[1], repo: m[2] } : null;
}

async function fetchGithubReadme(url) {
    const info = extractGithubRepo(url);
    if (!info) return null;
    const rawUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/HEAD/README.md`;
    try {
        const result = await scrapeUrl(rawUrl);
        if (!result.error && result.text) {
            result.title = `README — ${info.owner}/${info.repo}`;
            return result;
        }
    } catch (_) {}
    return null;
}

// ─── AI Tool Loop ─────────────────────────────────────────────────────────────

const FETCH_TAG_RE = /\[FETCH:\s*(https?:\/\/[^\]\s]+)\]/g;
const MAX_TOOL_ITERATIONS = 2;

async function callAIWithTools(model, messages) {
    let current = [...messages];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const response = await callAI(model, current);

        const fetchMatches = [...response.matchAll(FETCH_TAG_RE)];
        if (fetchMatches.length === 0) {
            // No tool calls — strip any stray tags and return
            return response.replace(FETCH_TAG_RE, '').trim();
        }

        current.push({ role: 'assistant', content: response });

        const urlsToFetch = [...new Set(
            fetchMatches.map(m => m[1]).filter(u => !isPrivateUrl(u)),
        )].slice(0, 3);

        console.log(`[Tool] AI requested FETCH (iter ${i + 1}): ${urlsToFetch.join(', ')}`);

        let fetchedContext = '';
        try {
            const results = await scrapeMultiple(urlsToFetch);
            fetchedContext = results.map(r =>
                r.error
                    ? `[FETCH RESULT: ${r.url}]\nError: ${r.error}`
                    : `[FETCH RESULT: ${r.url}]\nTitle: ${r.title ?? ''}\n${r.text}`,
            ).join('\n\n---\n\n');
        } catch (err) {
            fetchedContext = `[FETCH ERROR: ${err.message}]`;
        }

        current.push({
            role: 'user',
            content: `追加情報:\n${fetchedContext}\n\n以上を踏まえて最終的な回答を日本語で返してください。`,
        });
    }

    // Final call after exhausting iterations
    const final = await callAI(model, current);
    return final.replace(FETCH_TAG_RE, '').trim();
}

// ─── Prompt Helpers ───────────────────────────────────────────────────────────

function buildScrapedContext(results) {
    const parts = results.map((r, i) => {
        if (r.error) return `[Page ${i + 1}: ${r.url}]\nError: ${r.error}`;
        return `[Page ${i + 1}: ${r.url}]\nTitle: ${r.title ?? '(no title)'}\n${r.text}`;
    });

    // Trim total length to avoid overwhelming the model
    const combined = [];
    let total = 0;
    for (const part of parts) {
        if (total + part.length > MAX_CONTEXT_CHARS) {
            const remaining = MAX_CONTEXT_CHARS - total;
            if (remaining > 200) combined.push(part.slice(0, remaining));
            break;
        }
        combined.push(part);
        total += part.length;
    }
    return combined.join('\n\n---\n\n');
}

async function generateSummary(results, model, images, originalUrl, availableLinks = []) {
    // GitHub: prepend README to context
    if (originalUrl && extractGithubRepo(originalUrl)) {
        console.log(`[Summary] GitHub URL detected — fetching README`);
        const readme = await fetchGithubReadme(originalUrl);
        if (readme) {
            results = [readme, ...results];
            console.log(`[Summary] README fetched (${readme.text.length} chars)`);
        }
    }

    const contextText = buildScrapedContext(results);
    const validImages = images.filter(url => IMAGE_EXT_RE.test(url));

    const linksHint = availableLinks.length > 0
        ? '\n\n参照可能なリンク（必要なら [FETCH: url] で取得）:\n' +
          availableLinks.slice(0, 10).map(l => `- ${l}`).join('\n')
        : '';

    const instruction =
        '以下は取得したウェブページのテキスト情報です。これらをすべて統合し、' +
        'ページの目的・主な内容・重要なポイントを日本語で分かりやすくまとめてください。' +
        '「資料1」「Source」などの見出しは使わず、流れのある文章で要約してください。\n\n' +
        contextText + linksHint;

    let userContent;
    if (validImages.length > 0 && model === MODELS.SUMMARY_IMAGE) {
        userContent = [
            { type: 'text', text: instruction },
            ...validImages.slice(0, 3).map(imgUrl => ({
                type: 'image_url',
                image_url: { url: imgUrl },
            })),
        ];
    } else {
        userContent = instruction;
    }

    return callAIWithTools(model, [
        {
            role: 'system',
            content:
                'あなたはWebページの内容を日本語で要約する専門家です。' +
                '【重要】回答は必ず日本語で書いてください。英語は一切使わないでください。' +
                '与えられたテキストを読み込み、ページの目的・主な内容・重要なポイントを' +
                '自然な日本語の文章で簡潔にまとめてください。' +
                '「資料」「Source」などの見出しは使わず、流れのある文章で記述してください。' +
                '追加で調査が必要なURLがある場合は [FETCH: https://...] の形式で指定してください。',
        },
        { role: 'user', content: userContent },
    ]);
}

async function isAdvancedQuestion(question) {
    const result = await callAI(MODELS.SMALL, [
        {
            role: 'system',
            content:
                'You are a question complexity classifier. Reply with exactly one word: "advanced" or "basic".\n' +
                '"advanced": requires deep technical knowledge, complex reasoning, or detailed multi-step analysis.\n' +
                '"basic": simple factual lookups, short explanations, or straightforward questions.',
        },
        { role: 'user', content: question },
    ]);
    return result.trim().toLowerCase().startsWith('advanced');
}

function buildThreadMessages(context, question) {
    return [
        {
            role: 'system',
            content:
                'あなたはWebページの内容についての質問に答えるアシスタントです。' +
                '【重要】回答は必ず日本語で書いてください。英語は一切使わないでください。' +
                '以下のスクレイピングされた情報を参照して、正確かつ丁寧に日本語で回答してください。' +
                '情報が不足している場合は [FETCH: https://...] の形式でURLを指定すると追加情報を取得できます。\n\n' +
                buildScrapedContext(context.scrapedData),
        },
        ...context.history.slice(-MAX_CONTEXT_HISTORY),
        { role: 'user', content: question },
    ];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleUrlMessage(message, url) {
    console.log(`[URL] scraping: ${url}`);

    let mainResult;
    try {
        mainResult = await scrapeUrl(url);
    } catch (err) {
        console.error(`[URL] scrape failed for ${url}:`, err.message);
        return;
    }

    if (mainResult.error) {
        console.warn(`[URL] scraper error for ${url}: ${mainResult.error}`);
        return;
    }
    console.log(`[URL] scraped OK — images:${mainResult.images?.length ?? 0} links:${mainResult.links?.length ?? 0}`);

    // Provide available links as hints — AI fetches them on demand via [FETCH:]
    const availableLinks = (mainResult.links ?? [])
        .filter(l => !isPrivateUrl(l) && isUsefulRecursiveUrl(l))
        .slice(0, 10);

    const hasImages = (mainResult.images ?? []).length > 0;
    const model = hasImages ? MODELS.SUMMARY_IMAGE : MODELS.SUMMARY_TEXT;
    console.log(`[URL] summarizing with ${model}`);

    let summary;
    try {
        summary = await generateSummary([mainResult], model, mainResult.images ?? [], url, availableLinks);
    } catch (err) {
        console.error('[URL] summary error:', err.message);
        return;
    }

    let thread;
    try {
        const threadName = (mainResult.title || url).slice(0, 100);
        thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
        console.log(`[URL] thread created: ${thread.id}`);
    } catch (err) {
        console.error('[URL] thread creation error:', err.message);
        return;
    }

    threadStore.set(thread.id, {
        originalUrl: url,
        scrapedData: [mainResult],
        availableLinks,
        history: [],
    });

    await sendLong(thread, summary);
}

async function handleThreadMessage(message) {
    const context = threadStore.get(message.channel.id);
    if (!context) return;

    console.log(`[Thread] question in ${message.channel.id}: "${message.content.slice(0, 80)}"`);
    try { await message.channel.sendTyping(); } catch (_) {}

    let answer;
    try {
        const advanced = await isAdvancedQuestion(message.content);
        const model = advanced ? MODELS.LARGE : MODELS.SUMMARY_TEXT;
        console.log(`[Thread] classified as ${advanced ? 'advanced' : 'basic'} → ${model}`);
        answer = await callAIWithTools(model, buildThreadMessages(context, message.content));
    } catch (err) {
        console.error('[Thread] answer error:', err.message);
        await message.reply('エラーが発生しました。もう一度お試しください。');
        return;
    }

    context.history.push(
        { role: 'user', content: message.content },
        { role: 'assistant', content: answer },
    );

    await replyLong(message, answer);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

client.once(Events.ClientReady, c => {
    console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.channel.isThread() && threadStore.has(message.channel.id)) {
        await handleThreadMessage(message);
        return;
    }

    if (!ALLOWED_CHANNELS.has(message.channel.id)) return;

    let urls = [];

    if (message.channel.id === CHANNEL_MENTION_ONLY) {
        // Only act when the bot is mentioned
        if (!message.mentions.has(client.user)) return;

        // URL in the mention message itself
        const inMessage = (message.content.match(URL_REGEX) ?? [])
            .filter(u => !isPrivateUrl(u));

        if (inMessage.length > 0) {
            urls = [...new Set(inMessage)];
        } else if (message.reference?.messageId) {
            // No URL in mention message — look at the replied-to message
            try {
                const ref = await message.channel.messages.fetch(message.reference.messageId);
                const inRef = (ref.content.match(URL_REGEX) ?? [])
                    .filter(u => !isPrivateUrl(u));
                urls = [...new Set(inRef)];
            } catch (err) {
                console.error('[Event] failed to fetch reference message:', err.message);
            }
        }
    } else {
        // CHANNEL_ANY_URL: process every URL in the message
        const matches = message.content.match(URL_REGEX) ?? [];
        urls = [...new Set(matches)].filter(u => !isPrivateUrl(u));
    }

    if (urls.length === 0) return;

    console.log(`[Event] URLs detected in channel ${message.channel.id}: ${urls.join(', ')}`);
    for (const url of urls) {
        await handleUrlMessage(message, url);
    }
});

client.login(process.env.DISCORD_TOKEN);
