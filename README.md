# AI Visibility — GEO & SEO Platform

A comprehensive Generative Engine Optimization (GEO) & SEO tracking, scoring, and knowledge-graph platform. It monitors how websites appear in AI answer engines (ChatGPT, Google Gemini, Anthropic Claude, Perplexity), analyzes E-E-A-T credibility, constructs an entity-relationship knowledge graph, and automates instant search indexation and distribution.

## Key Features

- **Multi-LLM Citation & Visibility Tracking**: Automated benchmarking across ChatGPT, Gemini, Claude, and Perplexity.
- **Knowledge Graph & Graphify Engine**: Extracts entities (Products, Categories, FAQs, Authors) and semantic relationships into a queryable graph.
- **Four-Pillar GEO Scoring**:
  1. *AI Bot Accessibility* (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`).
  2. *Semantic & Direct Answer Readability*.
  3. *Information Trust & E-E-A-T* (Author credibility, citation density, verifiable facts).
  4. *Schema.org JSON-LD Completeness*.
- **Modern AI Submitter & Feeder**: IndexNow protocol for real-time Bing/ChatGPT indexing, dynamic `llms.txt` generation, and structured product syndication.
- **Actionable Remediation Engine**: Prioritized, copy-pasteable schema and configuration recommendations.
- **Scheduled Audits & Reporting**: Daily and weekly automated audits with trend reports.

---

## Architecture & Services

The platform is designed as a unified monorepo:

```
ai-visibility/
├── src/                     # Full-stack Next.js 16 core platform & API
│   ├── app/                 # App Router pages and REST API handlers
│   │   ├── api/sites/       # Site management, audits, graph & reports
│   │   └── api/health/      # System health endpoint
│   ├── lib/
│   │   ├── services/        # Domain services (audit, graph, sites, reports)
│   │   ├── db.ts            # Prisma client singleton
│   │   └── validation.ts    # Zod request validators
│   └── proxy.ts             # API token security guard
├── prisma/                  # Database schema & migrations (SQLite/PostgreSQL)
├── services/
│   └── crawler/             # Python 3.10+ async crawler & Knowledge Graph engine
│       ├── src/geo_crawler/ # Crawler, parser, entity extractor, graphify
│       └── tests/           # Unit & integration test suite (respx)
└── tests/                   # Vitest API test suite
```

---

## Tech Stack

- **Core Web & API**: Next.js 16 (App Router, Turbopack), TypeScript, Tailwind CSS 4.
- **ORM & Database**: Prisma 6 (SQLite for development, PostgreSQL for production).
- **Validation & Testing**: Zod 4, Vitest.
- **Crawler & Graph Engine** (`services/crawler`): Python 3.10+, HTTPX (async), BeautifulSoup4, lxml, NetworkX.

---

## Quick Start

### 1. Web Application & API

```bash
# Install dependencies and generate Prisma client
npm install

# Copy environment variables template
cp .env.example .env

# Run migrations and seed demo data
npm run db:migrate

# Start development server
npm run dev
# -> http://localhost:3000

# Run API tests
npm test

# Build for production
npm run build
```

### 2. Crawler & Knowledge Graph Service

```bash
cd services/crawler

# Install package in editable mode with test dependencies
pip install -e '.[dev]'

# Run crawler tests
pytest -q

# Example CLI crawl command:
geo-crawler https://example.com -o graph.json --db-records records.json --depth 2 --max-pages 50 --rps 5 -v
```

---

## API Endpoints

All responses are formatted in JSON with standard HTTP status codes.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | System and database health status |
| `GET` | `/api/sites` | List tracked sites with latest GEO audit summary |
| `POST` | `/api/sites` | Register a new site for tracking |
| `GET` | `/api/sites/:id` | Retrieve site details and configuration |
| `PATCH` | `/api/sites/:id` | Update site properties and integration credentials |
| `DELETE` | `/api/sites/:id` | Remove a site and cascade-delete associated audits |
| `POST` | `/api/sites/:id/audit` | Trigger an asynchronous GEO audit and crawl run |
| `GET` | `/api/sites/:id/audit` | Get recent audits and active crawl session progress |
| `GET` | `/api/sites/:id/graph` | Fetch knowledge graph nodes, edges, and semantic gaps |
| `GET/POST` | `/api/sites/:id/visibility` | Query suggestions/history and bounded multi-model visibility checks ([usage](docs/visibility.md)) |
| `GET` | `/api/sites/:id/reports` | Get score trends, LLM visibility metrics, and action items |
| `GET/POST`| `/api/sites/:id/reports/schedules` | Manage daily and weekly automated report schedules |

---

## Configuration

Refer to `.env.example` for all configurable environment variables:
- `DATABASE_URL`: SQLite or PostgreSQL connection string.
- `API_TOKEN`: Bearer token for securing API endpoints; mandatory for paid visibility POST requests, optional elsewhere.
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`: Multi-model visibility testing keys.
- `INDEXNOW_KEY`, `INDEXNOW_HOST`: Instant Bing / ChatGPT search indexation configuration.
- `SMTP_*`: Notification and scheduled report delivery settings.

---

## License & Attribution

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)**.

### Author & Attribution
- **Original Author**: Umut ADALI ([@kobeumut](https://github.com/kobeumut))
- **Source Repository**: [https://github.com/kobeumut/ai-visibility](https://github.com/kobeumut/ai-visibility)

### Terms:
1. **Attribution (BY)**: Any fork, redistribution, or modification of this software must clearly credit **Umut ADALI** as the original creator and provide a direct link to the original repository.
2. **Non-Commercial (NC)**: You may **not** sell, sublicense, or distribute this software or derivative works for commercial advantage or monetary compensation.
3. **Share-Alike (SA)**: If you modify, transform, or build upon this codebase, you must distribute your contributions under the identical CC BY-NC-SA 4.0 license.
4. **Disclaimer of Liability**: This software is provided "AS IS", without warranty of any kind, express or implied. In no event shall the author or copyright holder (**Umut ADALI**) be liable for any claim, damages, or other liability arising from the use of or inability to use this software.
