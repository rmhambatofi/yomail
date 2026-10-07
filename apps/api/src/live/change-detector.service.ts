import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import type { RequestSummary } from '@yomail/shared';
import { EndpointsService } from '../endpoints/endpoints.service';
import { CapturedRequest } from '../requests/request.entity';
import { SUMMARY_COLUMNS, toSummary } from '../requests/request.mapper';
import type { SummaryRow } from '../requests/request.mapper';
import { SettingsService } from '../settings/settings.service';

export const POLL_INTERVAL_MS = 2_000;
/** Re-read this far behind the last seen row so a row committed late is not missed. */
const OVERLAP_MS = 1_000;
/** How long an emitted id is remembered to suppress the duplicate from the other path. */
const REMEMBER_MS = 15_000;
const MAX_ROWS_PER_TICK = 500;

/**
 * Finds requests inserted by ANY process (Passenger may run several) for the
 * endpoints that have at least one subscriber, by polling the database every
 * POLL_INTERVAL_MS. The in-memory path (LiveEventsService) delivers instantly
 * within the capturing process; this covers the rest. Ids emitted by either path
 * are remembered for REMEMBER_MS so the same process does not emit a row twice.
 */
@Injectable()
export class ChangeDetector {
  private readonly logger = new Logger(ChangeDetector.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Last received_at seen per endpoint; set to "now" when tracking starts. */
  private readonly since = new Map<string, Date>();
  private readonly emitted = new Map<string, number>();
  private activeEndpoints: () => string[] = () => [];
  private deliver: (request: RequestSummary) => void = () => {};

  constructor(
    @InjectRepository(CapturedRequest) private readonly requests: Repository<CapturedRequest>,
    private readonly settings: SettingsService,
    private readonly endpoints: EndpointsService,
  ) {}

  /** Wires the gateway in and starts polling. */
  start(activeEndpoints: () => string[], deliver: (request: RequestSummary) => void): void {
    this.activeEndpoints = activeEndpoints;
    this.deliver = deliver;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called when an endpoint gains its first subscriber: only rows after this instant are reported. */
  track(endpointId: string): void {
    if (!this.since.has(endpointId)) this.since.set(endpointId, new Date());
  }

  /** Called by the gateway for rows emitted through the in-memory path. */
  remember(id: string): void {
    this.emitted.set(id, Date.now());
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.prune();
      const endpoints = this.activeEndpoints();
      for (const id of this.since.keys()) if (!endpoints.includes(id)) this.since.delete(id);
      if (endpoints.length === 0) return;
      for (const id of endpoints) this.track(id);

      const minSince = new Date(
        Math.min(...endpoints.map((id) => this.since.get(id)!.getTime())) - OVERLAP_MS,
      );
      const rows = (await this.requests.find({
        select: [...SUMMARY_COLUMNS],
        where: { endpointId: In(endpoints), receivedAt: MoreThan(minSince) },
        order: { receivedAt: 'ASC' },
        take: MAX_ROWS_PER_TICK,
      })) as SummaryRow[];
      if (rows.length === 0) return;

      // expires_at depends on whether a member owns the endpoint (phase 8.4).
      const [retention, retentionMembers, owned] = await Promise.all([
        this.settings.getRetentionDays(false),
        this.settings.getRetentionDays(true),
        this.endpoints.ownedMap([...new Set(rows.map((r) => r.endpointId))]),
      ]);
      for (const row of rows) {
        const seen = this.since.get(row.endpointId);
        if (seen && row.receivedAt.getTime() > seen.getTime())
          this.since.set(row.endpointId, row.receivedAt);
        if (this.emitted.has(row.id)) continue;
        this.emitted.set(row.id, Date.now());
        this.deliver(toSummary(row, owned.get(row.endpointId) ? retentionMembers : retention));
      }
    } catch (err) {
      this.logger.error(`change detection failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - REMEMBER_MS;
    for (const [id, at] of this.emitted) if (at < cutoff) this.emitted.delete(id);
  }
}
