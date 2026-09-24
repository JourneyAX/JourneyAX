import { PieceAuth, Property } from '@activepieces/pieces-framework';

export interface JourneyAxAuthData {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  environmentId: 'production' | 'staging' | 'test' | 'dev';
  webhookSecret?: string;
}

export const journeyaxAuth = PieceAuth.CustomAuth({
  description: 'Authenticate with your JourneyAX instance. Each connection is immutably scoped to a specific tenant and environment to prevent cross-tenant operations.',
  required: true,
  props: {
    baseUrl: Property.ShortText({
      displayName: 'JourneyAX Base URL',
      description: 'The base URL of the JourneyAX API Gateway or Runtime Service (e.g. https://api.journeyax.com or http://localhost:3009)',
      required: true,
      defaultValue: 'http://localhost:3009',
    }),
    apiKey: PieceAuth.SecretText({
      displayName: 'Tenant-Scoped API / Service Key',
      description: 'API key scoped to this specific tenant and environment for authenticated server-to-server JourneyAX requests',
      required: true,
    }),
    tenantId: Property.ShortText({
      displayName: 'Tenant ID',
      description: 'Immutable tenant identifier for this connection (e.g. workweargroup or royalcyber)',
      required: true,
    }),
    environmentId: Property.StaticDropdown({
      displayName: 'Environment',
      description: 'Immutable environment for this connection',
      required: true,
      defaultValue: 'production',
      options: {
        options: [
          { label: 'Production', value: 'production' },
          { label: 'Staging', value: 'staging' },
          { label: 'Test', value: 'test' },
          { label: 'Development', value: 'dev' },
        ],
      },
    }),
    webhookSecret: PieceAuth.SecretText({
      displayName: 'Webhook Signing Secret',
      description: 'Tenant-scoped HMAC-SHA256 secret for cryptographic callback verification',
      required: false,
    }),
  },
});
