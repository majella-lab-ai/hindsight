/**
 * Minimal Hindsight HTTP client for use inside the plugin worker.
 *
 * Uses native fetch (Node 20+). No external dependencies.
 */

export interface Memory {
  text: string;
  type?: string;
  /** Paperclip comment id — set as `document_id` at retain time. */
  document_id?: string;
  /** Retain-time attribution (agentId, companyId, issueId, commentId). */
  metadata?: Record<string, string>;
}

export interface RecallResponse {
  results: Memory[];
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token?: string, timeoutMs?: number) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} from ${path}: ${text}`);
      }

      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(bankId: string, query: string, budget = "mid"): Promise<RecallResponse> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    return this.request<RecallResponse>("POST", path, {
      query,
      budget,
      max_tokens: 1024,
    });
  }

  async retain(
    bankId: string,
    content: string,
    documentId?: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      context: "paperclip",
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true });
  }

  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

export function formatMemories(memories: Memory[]): string {
  if (memories.length === 0) return "";
  return memories.map((m) => formatMemory(m)).join("\n");
}

/**
 * Render a single memory with a citable source when one is available.
 *
 * The plugin retains the Paperclip comment id as `document_id` and repeats it,
 * together with the issue id, in `metadata`. We surface the tightest citation we
 * have so the "cite ta source" rule becomes verifiable from the recall output.
 */
function formatMemory(m: Memory): string {
  const source = memorySource(m);
  return source ? `- ${m.text} [source: ${source}]` : `- ${m.text}`;
}

function memorySource(m: Memory): string | undefined {
  const issueId = m.metadata?.issueId;
  const commentId = m.metadata?.commentId ?? m.document_id;
  if (issueId && commentId) return `${issueId}#${commentId}`;
  if (commentId) return `comment:${commentId}`;
  if (issueId) return `issue:${issueId}`;
  return undefined;
}
