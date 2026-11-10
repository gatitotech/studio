import { ToolError } from './errors.js';

const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT = 100_000;

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return match ? decodeEntities(match[1]).trim().slice(0, 200) : '';
}

function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ToolError('bad_url', 'That URL is not valid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ToolError('bad_url', 'Only http and https URLs are supported.');
  const host = url.hostname.toLowerCase();
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata') {
    throw new ToolError('blocked_url', 'Cloud metadata endpoints are blocked.');
  }
  if (host === '0.0.0.0' || host === '[::]') throw new ToolError('blocked_url', 'That host is not reachable.');
  return url;
}

async function fetchText(url, { signal, timeoutMs = 30_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GatitaStudio/0.1',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        ...headers,
      },
    });
    if (!response.ok) throw new ToolError('http_error', `The server returned ${response.status}.`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const reader = response.body?.getReader();
    if (!reader) throw new ToolError('empty_response', 'That page returned no content.');
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        size += value.length;
        chunks.push(Buffer.from(value));
        if (size > MAX_FETCH_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Ignore.
          }
          break;
        }
      }
      if (done) break;
    }
    return {
      contentType,
      size,
      text: Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES).toString('utf8'),
      finalUrl: response.url || String(url),
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (signal?.aborted) throw new ToolError('aborted', 'Cancelled.');
    if (controller.signal.aborted) throw new ToolError('timeout', 'That request timed out.');
    throw new ToolError('fetch_failed', `Could not fetch that page: ${error.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function clip(value, max = MAX_OUTPUT) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n… truncated` : text;
}

export function createWebfetchTool({ config }) {
  return {
    name: 'webfetch',
    group: 'web',
    description: 'Fetch a web page and return readable text. HTML is converted to plain text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https URL.' },
        format: { type: 'string', enum: ['text', 'markdown'], description: 'Output format, default text.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const url = assertSafeUrl(args.url);
      const result = await fetchText(url, { signal: context?.signal });
      const base = {
        title: `Fetched ${url.hostname}`,
        meta: { url: result.finalUrl, bytes: result.size, contentType: result.contentType },
      };
      if (result.contentType.includes('application/json')) {
        let formatted = result.text;
        try {
          formatted = JSON.stringify(JSON.parse(result.text), null, 2);
        } catch {
          // Keep raw text.
        }
        return { ...base, output: clip(formatted) };
      }
      if (result.contentType.includes('text/html') || result.text.slice(0, 200).toLowerCase().includes('<html')) {
        const title = extractTitle(result.text);
        const text = htmlToText(result.text);
        return { ...base, output: clip(`${title ? `${title}\n\n` : ''}${text}`) };
      }
      return { ...base, output: clip(result.text) };
    },
  };
}

function decodeDuckUrl(href) {
  const text = decodeEntities(String(href || ''));
  try {
    const url = new URL(text, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return text;
  }
}

function parseDuckDuckGo(html) {
  const results = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let snippetMatch;
  while ((snippetMatch = snippetPattern.exec(html))) {
    snippets.push(htmlToText(snippetMatch[1]).replace(/\s+/g, ' ').trim());
  }
  let match;
  while ((match = pattern.exec(html))) {
    const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    results.push({
      title,
      url: decodeDuckUrl(match[1]),
      snippet: snippets[results.length] || '',
    });
  }
  return results;
}

async function braveSearch(query, signal) {
  const key = String(process.env.BRAVE_SEARCH_API_KEY || process.env.GATITA_SEARCH_API_KEY || '').trim();
  if (!key) return null;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '8');
  const result = await fetchText(url, {
    signal,
    timeoutMs: 20_000,
    headers: { accept: 'application/json', 'x-subscription-token': key },
  });
  const payload = JSON.parse(result.text);
  return (payload.web?.results || []).map((entry) => ({
    title: entry.title,
    url: entry.url,
    snippet: entry.description || '',
  }));
}

export function createWebsearchTool({ config }) {
  return {
    name: 'websearch',
    group: 'web',
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const query = String(args.query || '').trim();
      if (!query) throw new ToolError('bad_arguments', 'query is required.');
      let results = null;
      try {
        results = await braveSearch(query, context?.signal);
      } catch {
        results = null;
      }
      if (!results) {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const page = await fetchText(url, { signal: context?.signal });
        results = parseDuckDuckGo(page.text);
      }
      if (!results.length) return { title: `Searched ${query}`, output: 'No results found.' };
      const output = results.slice(0, 8).map((entry, index) => [
        `${index + 1}. ${entry.title}`,
        `   ${entry.url}`,
        entry.snippet ? `   ${entry.snippet}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      return { title: `Searched ${query}`, output, meta: { results: results.length } };
    },
  };
}
