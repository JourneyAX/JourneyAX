# PlaceMakers Business Pack (Canonical Release v1.0.0)

## Overview
This Business Pack defines the canonical configuration, journeys, agents, vocabulary, and model routing policies for **PlaceMakers New Zealand** (Fletcher Building Ltd).

## Data Residency & Sovereign Processing Policy
- **Primary Data Residency**: New Zealand (`nz`).
- **Accepted Cloud Processing Residencies**: `['nz', 'au', 'us']`.
- **Residency Attestation**:
  - Provider: Google Cloud Vertex / Gemini API & OpenAI.
  - Attested Region: Australasia (`au` / `ap-southeast-2`) and global fallback (`us`).
  - Legal Basis: Enterprise Cloud Agreement (Fletcher Building Ltd cross-border data processing terms).
- **Enforcement**:
  - Handled by `ModelGateway` in `journey-runtime-service`.
  - Endpoint discovery validates configured regional hosts (e.g. Sydney `ap-southeast-2` / `au` or `us`) against `acceptedResidencies` and `residencyAttestation`.
