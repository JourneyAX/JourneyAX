# placemakers evidence inventory

Snapshot: **2026-10-13T01:41:44.770Z** (read-only). Databases: runtime=`journeyx`, project=`journeyax`.

## 1. Business Pack (source: `business_pack_pointers`, `business_pack_releases`)

| database | environment | active version | revision | status |
|---|---|---|---|---|
| journeyx | production | 1.0.38 | 29 | active |
| journeyax | production | 1.0.33 | 1 | active |

Active production pack: **1.0.38**, checksum `86e58016c7355ef3…`, published 2026-10-08T14:12:42.827Z by admin.
OKF reference in the active pack: **none**.
Fact registry facts in the active pack: **0**. Catalogue mapping in the active pack: **absent**.

| journey | stages | stages with required facts | capabilities used |
|---|---|---|---|
| placemakers_shop | 3 | 0 | products |
| placemakers_plan_your_space | 8 | 0 | openSpacePlanner, buildProjectPlan |
| placemakers_services | 3 | 0 | choice |
| placemakers_tools___guides | 4 | 0 | installGuide, products |
| placemakers_customer_service | 3 | 0 | checkBranchStock |

Cards: allowed types = []; templates = [].
Tools defined: products, quote, steps, installGuide, warranty, buildProjectPlan, checkBranchStock, openSpacePlanner, domainClarify, choice.
Evaluation suites in pack: **0**.

## 2. Project draft (source: project database `tenant_configs`)

| field | value |
|---|---|
| config version | 31 |
| activeVersion | 38 |
| packVersion | 1.3.10 |
| environmentVersions | null |
| knowledgeModel reference | {"releaseId":"okf-placemakers-production-1.0.0","version":"1.0.0","checksum":"b105bf65de728228…","required":true,"failurePolicy":"fail_closed"} |
| factRegistry facts | fastener_substrate, leak_location |
| catalogMapping | absent |
| ai | openai/gpt-5.5 |
| updatedAt | 2026-10-12T14:39:12.226Z |


## 3. OKF releases and drafts (source: `okf_releases`, `okf_drafts`, `okf_*` collections)

| releaseId | environment | version | status | checksum | artifact | published |
|---|---|---|---|---|---|---|
| okf-placemakers-production-1.0.0 | production | 1.0.0 | ready | b105bf65de728228… | failed (OKF_ARTIFACT_BUCKET is required to export OKF releases) | human:mahaveer.it@gmail.com @ 2026-10-12T14:37:55.486Z |

| draft environment | revision | valid | concepts | checksum | updated |
|---|---|---|---|---|---|
| staging | 1 | true | 6 | 3c20961a8447edfa… | human:mahaveer.it@gmail.com @ 2026-10-12T14:18:38.285Z |
| production | 1 | true | 6 | 3c20961a8447edfa… | human:mahaveer.it@gmail.com @ 2026-10-12T14:37:55.294Z |

Row counts for this tenant: {"okf_concepts":6,"okf_relationships":1,"okf_sources":1,"okf_evidence_chunks":1,"okf_verification_records":0,"okf_fact_definitions":2,"okf_revocation_events":0}.

## 4. Catalogue (source: runtime database `products`)

Whole collection: **49938** documents (all tenants). placemakers: **42436** = 42413 (projectId=placemakers, tenantId=∅) + 1 (projectId=∅, tenantId=placemakers) + 22 (projectId=placemakers, tenantId=placemakers).
| department | products | groups | leaf categories |
|---|---|---|---|
| Bathrooms & Plumbing | 15256 | 2 | 20 |
| Tools | 8089 | 4 | 72 |
| Fastenings & General Hardware | 3122 | 2 | 22 |
| Outdoor & Landscaping | 2763 | 5 | 27 |
| Building Products | 1977 | 17 | 64 |
| Safety & Ladders | 1919 | 2 | 17 |
| Kitchens & Laundry | 1567 | 2 | 12 |
| Timber & Plywood | 1550 | 11 | 39 |
| Doors, Windows & Joinery Hardware | 1458 | 4 | 20 |
| Paint & Decorating | 1347 | 2 | 18 |
| Electrical & Heating/Cooling | 1130 | 2 | 17 |
| Sheds & Buildings | 571 | 1 | 1 |
| Adhesives & Sealants | 430 | 5 | 7 |
| (no department) | 395 | 0 | 14 |
| Cladding | 327 | 3 | 8 |
| Cleaning & Consumables | 262 | 4 | 10 |
| Wardrobes, Storage & Flooring | 253 | 2 | 9 |
| specials | 20 | 0 | 1 |

Departments: **18** (including any without a department). Distinct leaf categories: **376**. Products without a category: **381**.
| measure (source: products) | count |
|---|---|
| priced via priceUSD.min > 0 | 39720 |
| priced via variants[0].msrpUSD > 0 | 36780 |
| priced via priceCents > 0 | 0 |
| declares a currency | 42436 |
| discontinued = true | 1684 |
| has stock.availableBranchCount | 32189 |
| availability = true | 42422 |
| has images | 42128 |


## 5. Crawl documents and glossary (source: `documents`, `placemakers_domain_glossary`, `placemakers_domain_keywords`)

`documents`: **113403** chunks for placemakers across **94107** distinct source URLs (collection total 134696, all tenants). These are crawl chunks — evidence candidates only, never verified claims.
Glossary documents: 1; domain keywords: 1362.

## 6. Reconciliation of conflicting totals

| figure seen earlier | what it actually measures | reconciled |
|---|---|---|
| 49,938 products | every tenant in `products` | 42436 belong to placemakers |
| 134,696 documents | every tenant in `documents` | 113403 placemakers chunks |
| 42,436 products | placemakers across three ownership shapes | 42413 + 1 + 22 = 42436 |
| 377 categories | distinct leaf `category` values | 376 now |

Counts above are a point-in-time read; re-run the script to refresh them.
