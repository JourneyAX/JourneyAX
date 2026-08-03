# Caroma JourneyAX - Bathroom Configurator POC

A guided bathroom configurator for Caroma. **By default it runs on a traditional rule engine (zero AI tokens)** — clarify → match products → install/troubleshoot guides → quote/BOM. An optional AI/RAG mode remains available behind an env flag.

## 🚀 Key Features

*   **Traditional engine (default):** Keyword intent → fixed clarify chips → deterministic catalog match → template guides → BOM/quote. No OpenAI calls, so production never “runs out of tokens.”
*   **Conversational UI Routing:** The right-hand panel (Clarify, Products, Guide, Quote) updates from engine actions without page reloads.
*   **Optional AI mode:** Set `NEXT_PUBLIC_JOURNEY_ENGINE=ai` to use the OpenAI + MongoDB Atlas Vector Search path (RAG, freer language).
*   **Quoting & BOM:** Compiles selections, adds mandatory installation parts, and generates a structured Bill of Materials.

See [`docs/TRADITIONAL_ENGINE.md`](docs/TRADITIONAL_ENGINE.md) for the zero-token architecture.

## 🛠 Tech Stack

*   **Framework:** Next.js (App Router) + React
*   **Default orchestrator:** Local TypeScript rule engine (`src/lib/traditional/`)
*   **Optional AI:** OpenAI Chat Completions + MongoDB Atlas Vector Search
*   **Styling:** Vanilla CSS (custom `globals.css`)
*   **Language:** TypeScript

## 🏗 Getting Started (Local Development)

### Prerequisites
*   Node.js v18+
*   For AI mode only: MongoDB Atlas + OpenAI API Key

### 1. Installation
Clone the repository and install the dependencies:
```bash
git clone https://github.com/JourneyAX/caroma-journeyAX.git
cd caroma-journeyAX/journeyx-app
npm install
```

### 2. Environment Variables
Traditional mode needs **no** API keys.

Optional — AI mode only — create `.env.local`:
```env
NEXT_PUBLIC_JOURNEY_ENGINE=ai
OPENAI_API_KEY="sk-your-openai-api-key"
MONGODB_URI="mongodb+srv://<username>:<password>@cluster.mongodb.net/?retryWrites=true&w=majority"
```

### 3. Run the Development Server
Start the Next.js local server:
```bash
npm run dev
```
Open [http://localhost:3008](http://localhost:3008) in your browser to start the conversation!

## ☁️ Deployment (Vercel)

This application is fully optimized for Vercel deployment.

1. Push your code to GitHub.
2. Go to the [Vercel Dashboard](https://vercel.com/new) and click **Add New** -> **Project**.
3. Import this repository.
4. Expand the **Environment Variables** section and add `OPENAI_API_KEY` and `MONGODB_URI`.
5. Click **Deploy**.

## 📁 Repository Structure
*   `src/app/page.tsx`: The main application shell layout.
*   `src/app/api/chat/route.ts`: The core AI Orchestrator prompt and tool definitions.
*   `src/components/panels/`: The dynamic UI panels (Hero, Clarify, Products, Guide, Quote).
*   `src/context/JourneyContext.tsx`: The global state manager that tracks the user's phase, selections, and quotes.
*   `src/services/knowledge/`: Ingestion, chunking, and MongoDB Vector Search logic.

---
*Built as a Proof of Concept by JourneyAX.*
