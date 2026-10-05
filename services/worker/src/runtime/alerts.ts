import { redact, type Logger } from '@sellrelay/observability';
import { safeRequest, validateOutboundUrl } from '@sellrelay/security';
import type { Alert, AlertSink } from './types.ts';

/** Slack incoming-webhook alerts. URL restricted to hooks.slack.com; payload redacted. */
export class SlackAlertSink implements AlertSink {
  private readonly url: string;
  private readonly log: Logger;

  constructor(url: string, log: Logger) {
    this.log = log;
    this.url = validateOutboundUrl(url, { allowedHosts: ['hooks.slack.com'] }).toString();
  }

  async notify(alert: Alert): Promise<void> {
    const details = redact(alert.details ?? {}) as Record<string, unknown>;
    const text = `[${alert.severity.toUpperCase()}] ${alert.title}${alert.tenantId ? ` (tenant ${alert.tenantId})` : ''}\n\`\`\`${JSON.stringify(details)}\`\`\``;
    const res = await safeRequest(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      allowedHosts: ['hooks.slack.com'],
      timeoutMs: 5000,
      maxRedirects: 0,
    });
    if (res.status >= 300) this.log.warn({ status: res.status }, 'slack alert rejected');
  }
}

/** Fallback when no channel is configured: alerts are logged (and visible in activity). */
export class LogAlertSink implements AlertSink {
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }
  async notify(alert: Alert): Promise<void> {
    this.log.warn({ alert: redact(alert) }, 'alert');
  }
}
