export interface EngramConfig {
  url: string;
  project: string;
  maxResults: number;
  timeoutMs: number;
  autoRecall: boolean;
  recallLimit: number;
  recallMinScore: number;
}

export interface Observation {
  id: number;
  sync_id: string;
  session_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key: string;
  revision_count: number;
  duplicate_count: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  rank?: number;
}

export interface SaveRequest {
  session_id: string;
  title: string;
  content: string;
  type: string;
  project: string;
  topic_key?: string;
  scope?: string;
}

export interface UpdateRequest {
  title?: string;
  content?: string;
  type?: string;
  project?: string;
  topic_key?: string;
}

export function parseConfig(value: unknown): EngramConfig {
  const v = (value as Record<string, unknown>) || {};
  return {
    url: (v.url as string) || "http://127.0.0.1:7437",
    project: (v.project as string) || "general",
    maxResults: (v.maxResults as number) || 10,
    timeoutMs: (v.timeoutMs as number) || 5000,
    autoRecall: v.autoRecall !== false,
    recallLimit: (v.recallLimit as number) || 5,
    recallMinScore: (v.recallMinScore as number) || 0.3,
  };
}

export class EngramClient {
  private config: EngramConfig;
  private healthy: boolean | null = null;
  private knownSessions = new Set<string>();
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;

  constructor(config: EngramConfig) {
    this.config = config;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.onLog?.(level, msg);
  }

  private get baseUrl(): string {
    return this.config.url.replace(/\/+$/, "");
  }

  async checkHealth(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        this.healthy = false;
        return { ok: false };
      }
      const data = await res.json();
      this.healthy = true;
      return { ok: true, version: data.version };
    } catch {
      this.healthy = false;
      return { ok: false };
    }
  }

  async search(
    query: string,
    opts?: { project?: string; type?: string; scope?: string; limit?: number },
  ): Promise<Observation[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(opts?.limit ?? this.config.maxResults),
    });
    if (opts?.project) params.set("project", opts.project);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.scope) params.set("scope", opts.scope);

    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/search?${params}`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        this.log("warn", `search failed: HTTP ${res.status} for q="${query}" (${Date.now() - t0}ms)`);
        return [];
      }
      const data = await res.json();
      const results = Array.isArray(data) ? data : [];
      this.log("info", `search: q="${query}" → ${results.length} results${opts?.project ? ` (project=${opts.project})` : ""} (${Date.now() - t0}ms)`);
      return results;
    } catch (err) {
      this.log("error", `search error: q="${query}" → ${String(err)} (${Date.now() - t0}ms)`);
      return [];
    }
  }

  async getObservation(id: number): Promise<Observation | null> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/observations/${id}`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        this.log("warn", `get failed: HTTP ${res.status} for #${id} (${Date.now() - t0}ms)`);
        return null;
      }
      const obs = await res.json();
      this.log("info", `get: #${id} "${obs.title}" (${Date.now() - t0}ms)`);
      return obs;
    } catch (err) {
      this.log("error", `get error: #${id} → ${String(err)} (${Date.now() - t0}ms)`);
      return null;
    }
  }

  /**
   * Ensures the session exists before saving. save.sh does the same:
   * POST /sessions first (silently), then POST /observations.
   * This prevents FOREIGN KEY constraint errors.
   */
  async ensureSession(sessionId: string, project: string): Promise<void> {
    if (this.knownSessions.has(sessionId)) return;
    try {
      await fetch(`${this.baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, project }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      this.knownSessions.add(sessionId);
    } catch {
      // Session may already exist — that's fine
    }
  }

  async save(req: SaveRequest): Promise<{ id: number } | null> {
    const t0 = Date.now();
    try {
      await this.ensureSession(req.session_id, req.project);

      const body: Record<string, string> = {
        session_id: req.session_id,
        title: req.title,
        content: req.content,
        type: req.type,
        project: req.project,
        scope: req.scope || "project",
      };
      if (req.topic_key) body.topic_key = req.topic_key;

      const res = await fetch(`${this.baseUrl}/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        this.log("warn", `save failed: HTTP ${res.status} for "${req.title}" in ${req.project} (${Date.now() - t0}ms)`);
        return null;
      }
      const result = await res.json();
      this.log("info", `save: #${result.id} "${req.title}" [${req.type}] → ${req.project}${req.topic_key ? ` (topic=${req.topic_key})` : ""} (${Date.now() - t0}ms)`);
      return result;
    } catch (err) {
      this.log("error", `save error: "${req.title}" → ${String(err)} (${Date.now() - t0}ms)`);
      return null;
    }
  }

  async update(id: number, req: UpdateRequest): Promise<Observation | null> {
    const t0 = Date.now();
    try {
      const body: Record<string, string> = {};
      if (req.title) body.title = req.title;
      if (req.content) body.content = req.content;
      if (req.type) body.type = req.type;
      if (req.project) body.project = req.project;
      if (req.topic_key) body.topic_key = req.topic_key;

      const fields = Object.keys(body).join(",");
      const res = await fetch(`${this.baseUrl}/observations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        this.log("warn", `update failed: HTTP ${res.status} for #${id} (${Date.now() - t0}ms)`);
        return null;
      }
      const result = await res.json();
      this.log("info", `update: #${id} fields=[${fields}] (${Date.now() - t0}ms)`);
      return result;
    } catch (err) {
      this.log("error", `update error: #${id} → ${String(err)} (${Date.now() - t0}ms)`);
      return null;
    }
  }

  async delete(id: number, hard = false): Promise<boolean> {
    const t0 = Date.now();
    try {
      const url = hard
        ? `${this.baseUrl}/observations/${id}?hard=true`
        : `${this.baseUrl}/observations/${id}`;
      const res = await fetch(url, {
        method: "DELETE",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.ok) {
        this.log("info", `delete: #${id}${hard ? " (hard)" : " (soft)"} (${Date.now() - t0}ms)`);
      } else {
        this.log("warn", `delete failed: HTTP ${res.status} for #${id} (${Date.now() - t0}ms)`);
      }
      return res.ok;
    } catch (err) {
      this.log("error", `delete error: #${id} → ${String(err)} (${Date.now() - t0}ms)`);
      return false;
    }
  }

  async getContext(project?: string): Promise<string> {
    const params = new URLSearchParams();
    if (project) params.set("project", project);

    try {
      const res = await fetch(`${this.baseUrl}/context?${params}`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) return "";
      const data = await res.json();
      return data.context || "";
    } catch {
      return "";
    }
  }

  async startSession(
    sessionId: string,
    project: string,
    directory?: string,
  ): Promise<boolean> {
    const t0 = Date.now();
    try {
      const body: Record<string, string> = { id: sessionId, project };
      if (directory) body.directory = directory;

      const res = await fetch(`${this.baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.ok) {
        this.knownSessions.add(sessionId);
        this.log("info", `session-start: "${sessionId}" project=${project} (${Date.now() - t0}ms)`);
      } else {
        this.log("warn", `session-start failed: HTTP ${res.status} for "${sessionId}" (${Date.now() - t0}ms)`);
      }
      return res.ok;
    } catch (err) {
      this.log("error", `session-start error: "${sessionId}" → ${String(err)} (${Date.now() - t0}ms)`);
      return false;
    }
  }

  async endSession(sessionId: string, summary: string): Promise<boolean> {
    const t0 = Date.now();
    try {
      const encoded = encodeURIComponent(sessionId);
      const res = await fetch(`${this.baseUrl}/sessions/${encoded}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.ok) {
        this.knownSessions.delete(sessionId);
        this.log("info", `session-end: "${sessionId}" (${Date.now() - t0}ms)`);
      } else {
        this.log("warn", `session-end failed: HTTP ${res.status} for "${sessionId}" (${Date.now() - t0}ms)`);
      }
      return res.ok;
    } catch (err) {
      this.log("error", `session-end error: "${sessionId}" → ${String(err)} (${Date.now() - t0}ms)`);
      return false;
    }
  }

  async getTimeline(
    observationId: number,
    before = 5,
    after = 5,
  ): Promise<unknown> {
    try {
      const params = new URLSearchParams({
        observation_id: String(observationId),
        before: String(before),
        after: String(after),
      });
      const res = await fetch(`${this.baseUrl}/timeline?${params}`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async getRecent(project?: string, limit = 10, scope?: string): Promise<Observation[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (project) params.set("project", project);
    if (scope) params.set("scope", scope);

    try {
      const res = await fetch(`${this.baseUrl}/observations/recent?${params}`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async getStats(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/stats`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async migrateProject(oldProject: string, newProject: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/projects/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_project: oldProject, new_project: newProject }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async exportData(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/export`, {
        signal: AbortSignal.timeout(this.config.timeoutMs * 3),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async importData(data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(this.config.timeoutMs * 3),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  normalizeScores(observations: Observation[]): Array<Observation & { score: number }> {
    if (observations.length === 0) return [];

    const maxAbsRank = Math.max(
      ...observations.map((o) => Math.abs(o.rank ?? 0)),
      1,
    );

    return observations.map((o) => ({
      ...o,
      score: o.rank ? Math.abs(o.rank) / maxAbsRank : 0,
    }));
  }

  suggestTopicKey(type: string, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    return `${type}/${slug}`;
  }
}
