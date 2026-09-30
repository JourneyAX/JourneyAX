import { Injectable } from '@nestjs/common';
import { TurnCommand, TurnResult } from '@journeyax/journey-core';
import { signGatewayAssertion } from '@journeyax/database';
import { GoogleAuth } from 'google-auth-library';

let cachedGcpIdToken: { token: string; expiresAt: number; audience: string } | null = null;
let cachedAuthClient: { keyPath: string; promise: Promise<import('google-auth-library').IdTokenClient> } | null = null;

async function getServiceAccountIdToken(targetAudience: string): Promise<string> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) return '';
  try {
    if (!cachedAuthClient || cachedAuthClient.keyPath !== keyPath) {
      cachedAuthClient = { keyPath, promise: new GoogleAuth().getIdTokenClient(targetAudience) };
    }
    const client = await cachedAuthClient.promise;
    return (await client.idTokenProvider.fetchIdToken(targetAudience)) || '';
  } catch {
    return '';
  }
}

export async function fetchWorkloadAuthorizationToken(targetAudience: string): Promise<string | undefined> {
  if (process.env.CLOUD_RUN_ID_TOKEN || process.env.GCP_ID_TOKEN) {
    return (process.env.CLOUD_RUN_ID_TOKEN || process.env.GCP_ID_TOKEN)!.trim();
  }

  if (!targetAudience || targetAudience.includes('localhost') || targetAudience.includes('127.0.0.1')) {
    return undefined;
  }

  const now = Date.now();
  if (cachedGcpIdToken && cachedGcpIdToken.audience === targetAudience && cachedGcpIdToken.expiresAt > now + 60_000) {
    return cachedGcpIdToken.token;
  }

  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetAudience)}`,
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1200),
      }
    );
    if (res.ok) {
      const token = (await res.text()).trim();
      cachedGcpIdToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
      return token;
    }
  } catch {
    // Non-GCP runtime
  }

  const saToken = await getServiceAccountIdToken(targetAudience);
  if (saToken) {
    cachedGcpIdToken = { token: saToken, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
    return saToken;
  }

  return undefined;
}

/**
 * CanonicalRuntimeAdapter
 *
 * Exclusively delegates Business Pack turn execution and SSE event streaming
 * to the canonical Journey Runtime service.
 * Eliminates duplicate journey/stage/agent/capability loops in Agent Commerce.
 */
@Injectable()
export class CanonicalRuntimeAdapter {
  private inProcessRuntime: {
    runTurn: (command: TurnCommand) => Promise<TurnResult>;
    streamTurn?: (command: TurnCommand, emit: (event: string, data: any) => void) => Promise<void>;
  } | null = null;

  private get runtimeUrl(): string {
    return (
      process.env.JOURNEY_RUNTIME_SERVICE_URL ||
      process.env.JOURNEY_RUNTIME_URL ||
      process.env.RUNTIME_SERVICE_URL ||
      'http://localhost:3012'
    );
  }

  /**
   * Allows injecting in-process RuntimeService for local testing without network sockets.
   */
  setInProcessRuntimeForTest(runtime: {
    runTurn: (command: TurnCommand) => Promise<TurnResult>;
    streamTurn?: (command: TurnCommand, emit: (event: string, data: any) => void) => Promise<void>;
  } | null): void {
    this.inProcessRuntime = runtime;
  }

  /**
   * Constructs authenticated request headers using internal-service authentication,
   * signed gateway assertion, and Cloud Run IAM workload authorization.
   * Does NOT rely on unverified raw principal headers.
   */
  async buildAuthenticatedHeaders(command: TurnCommand): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': command.tenantId,
    };

    if (command.correlationId) {
      headers['X-Correlation-ID'] = command.correlationId;
    }

    // 1. Workload identity (Internal Service Key)
    if (process.env.INTERNAL_API_KEY) {
      headers['X-Internal-Key'] = process.env.INTERNAL_API_KEY;
    }

    // 2. Cryptographically signed gateway assertion (when secret available)
    const assertionSecret = process.env.GATEWAY_ASSERTION_SECRET;
    if (assertionSecret) {
      const assertion = signGatewayAssertion(
        {
          tenantId: command.tenantId,
          environmentId: command.environmentId || 'production',
          sub: command.principalId || 'anonymous',
          role: (command.principalRole as any) || 'customer',
        },
        assertionSecret
      );
      headers['X-Gateway-Assertion'] = assertion;
    }

    // 3. Workload Authorization for Cloud Run (Authorization: Bearer <ID_TOKEN>)
    // Application internal keys and gateway assertions do not replace the Cloud Run Authorization ID token.
    const idToken = await fetchWorkloadAuthorizationToken(this.runtimeUrl);
    if (idToken) {
      headers['Authorization'] = `Bearer ${idToken}`;
    }

    return headers;
  }

  /**
   * Delegates a buffered turn request to canonical /runtime/turn.
   */
  async runTurn(command: TurnCommand): Promise<TurnResult> {
    if (this.inProcessRuntime) {
      return this.inProcessRuntime.runTurn(command);
    }

    const env = command.environmentId || 'production';
    const tenantId = command.tenantId;
    const url = `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(env)}/runtime/turn`;
    const headers = await this.buildAuthenticatedHeaders(command);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: command.tenantId,
        projectId: (command as any).projectId || command.tenantId,
        journeyId: (command as any).journeyId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        environment: (command as any).environment || command.environmentId || 'production',
        environmentId: command.environmentId || 'production',
        workspaceId: command.workspaceId || command.sessionId,
        message: command.message,
        event: command.event,
        inputFacts: command.inputFacts,
        approvalRequestId: command.approvalRequestId,
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(
        errBody.message || `Canonical runtime /turn returned status ${res.status}: ${res.statusText}`
      );
    }

    return (await res.json()) as TurnResult;
  }

  /**
   * Delivers turn events via canonical /runtime/chat/stream.
   * Pipes every SSE event directly to the caller's emit callback in arrival order without buffering.
   */
  async streamTurn(
    command: TurnCommand,
    emit: (event: string, data: any) => void
  ): Promise<void> {
    if (this.inProcessRuntime?.streamTurn) {
      return this.inProcessRuntime.streamTurn(command, emit);
    }

    if (this.inProcessRuntime && !this.inProcessRuntime.streamTurn) {
      // In-process delivery framing (session -> trace -> token -> uiAction -> data -> done)
      const result = await this.inProcessRuntime.runTurn(command);
      emit('session', { sessionId: command.sessionId });
      if (result.trace) {
        emit('trace', result.trace);
      }
      if (result.assistantMessage) {
        emit('token', { token: result.assistantMessage, delta: result.assistantMessage });
      }
      for (const inst of result.uiInstructions || []) {
        emit('uiAction', {
          name: 'presentCard',
          arguments: {
            card: {
              id: inst.actionId || `${inst.component}-${Date.now()}`,
              cardType: inst.component,
              state: inst.props,
            },
          },
          card: {
            cardType: inst.component,
            state: inst.props,
          },
        });
      }
      emit('data', {
        sessionId: command.sessionId,
        workspaceId: command.workspaceId,
        decision: result.decision,
        trace: result.trace,
      });
      emit('done', {
        sessionId: command.sessionId,
        workspaceId: command.workspaceId,
        decision: result.decision,
        trace: result.trace,
        response: result.assistantMessage || '',
        assistantMessage: result.assistantMessage || '',
        message: { role: 'assistant', content: result.assistantMessage || '' },
      });
      return;
    }

    const env = command.environmentId || 'production';
    const tenantId = command.tenantId;
    const url = `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(env)}/runtime/chat/stream`;
    const headers = await this.buildAuthenticatedHeaders(command);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: command.tenantId,
        projectId: (command as any).projectId || command.tenantId,
        journeyId: (command as any).journeyId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        environment: (command as any).environment || command.environmentId || 'production',
        environmentId: command.environmentId || 'production',
        workspaceId: command.workspaceId || command.sessionId,
        message: command.message,
        event: command.event,
        inputFacts: command.inputFacts,
        approvalRequestId: command.approvalRequestId,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Canonical runtime /chat/stream failed with status ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Canonical runtime response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    const parseAndEmitFrame = (frame: string) => {
      const lines = frame.split(/\r?\n/);
      let currentEvent = 'message';
      const dataLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // skip comments / keep-alive
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === 'data') {
          dataLines.push('');
        }
      }

      if (dataLines.length > 0) {
        const rawData = dataLines.join('\n');
        let parsedData: any;
        try {
          parsedData = JSON.parse(rawData);
        } catch {
          parsedData = rawData;
        }
        if (currentEvent === 'token' && typeof parsedData === 'string') {
          parsedData = { token: parsedData, delta: parsedData };
        }
        emit(currentEvent, parsedData);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundaryIndex: number;
      while ((boundaryIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundaryIndex);
        const match = buffer.match(/\r?\n\r?\n/);
        buffer = buffer.slice(boundaryIndex + (match ? match[0].length : 2));
        if (frame.trim()) {
          parseAndEmitFrame(frame);
        }
      }
    }

    if (buffer.trim()) {
      parseAndEmitFrame(buffer);
    }
  }
}
